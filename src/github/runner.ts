import fs from 'node:fs';
import { App } from '@octokit/app';

export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  constructor() { super('GitHub API circuit breaker is open — request rejected until cooldown expires'); }
}

class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.openUntil) throw new CircuitOpenError();
    try {
      const result = await fn();
      this.failures = 0; // reset on success (handles half-open recovery)
      return result;
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) {
        this.failures++;
        if (this.failures >= this.threshold) {
          this.openUntil = Date.now() + this.cooldownMs;
          console.error(`[circuit-breaker] GitHub API opened after ${this.failures} failures, cooldown ${this.cooldownMs}ms`);
        }
      }
      throw err;
    }
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise(r => setTimeout(r, baseMs * 2 ** (i - 1) + Math.random() * 100));
    }
  }
  throw new Error('unreachable');
}

export class AppClient {
  private readonly app: App | null;
  private readonly token: string | null;
  private readonly breaker = new CircuitBreaker();

  private constructor(app: App | null, token: string | null) {
    this.app = app;
    this.token = token;
  }

  static fromGitHubApp(appId: number, privateKeyPath: string): AppClient {
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    return new AppClient(new App({ appId, privateKey }), null);
  }

  /** Read PEM from env var directly — avoids writing a temp file from Secrets Manager/SSM. */
  static fromGitHubAppKey(appId: number, privateKey: string): AppClient {
    return new AppClient(new App({ appId, privateKey }), null);
  }

  /** For local dev with a PAT — skips GitHub App auth entirely. */
  static fromToken(token: string): AppClient {
    return new AppClient(null, token);
  }

  async createRunnerToken(owner: string, repo: string): Promise<string> {
    return this.breaker.execute(() =>
      withRetry(() => this._createRunnerToken(owner, repo)),
    );
  }

  async listRunners(owner: string, repo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    return this.breaker.execute(() =>
      withRetry(() => this._listRunners(owner, repo)),
    );
  }

  async deleteRunner(owner: string, repo: string, runnerId: number): Promise<void> {
    return this.breaker.execute(() =>
      withRetry(() => this._deleteRunner(owner, repo, runnerId)),
    );
  }

  async listActiveRuns(owner: string, repo: string): Promise<Array<{ id: number }>> {
    return this.breaker.execute(() =>
      withRetry(() => this._listActiveRuns(owner, repo)),
    );
  }

  private async _listActiveRuns(owner: string, repo: string): Promise<Array<{ id: number }>> {
    const fetchRuns = async (status: string): Promise<Array<{ id: number }>> => {
      if (this.token) {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/runs?status=${status}&per_page=50`,
          { headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
        );
        if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
        const data = await res.json() as { workflow_runs: Array<{ id: number }> };
        return data.workflow_runs;
      }
      const installationId = await this.getInstallationId(owner);
      const octokit = await this.app!.getInstallationOctokit(installationId);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
        owner, repo, status: status as 'queued' | 'in_progress', per_page: 50,
      });
      return data.workflow_runs as Array<{ id: number }>;
    };

    const [queued, inProgress] = await Promise.all([fetchRuns('queued'), fetchRuns('in_progress')]);
    const seen = new Set<number>();
    return [...queued, ...inProgress].filter(r => seen.has(r.id) ? false : (seen.add(r.id), true));
  }

  async listJobsForRun(owner: string, repo: string, runId: number): Promise<Array<{ id: number; status: string; labels: string[] }>> {
    return this.breaker.execute(() =>
      withRetry(() => this._listJobsForRun(owner, repo, runId)),
    );
  }

  private async _listJobsForRun(owner: string, repo: string, runId: number): Promise<Array<{ id: number; status: string; labels: string[] }>> {
    if (this.token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        { headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
      const data = await res.json() as { jobs: Array<{ id: number; status: string; labels: string[] }> };
      return data.jobs;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner, repo, run_id: runId, filter: 'latest', per_page: 100,
    });
    return data.jobs as Array<{ id: number; status: string; labels: string[] }>;
  }

  private async _listRunners(owner: string, repo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    if (this.token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runners?per_page=100`,
        { headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
      const data = await res.json() as { runners: Array<{ id: number; name: string; status: string }> };
      return data.runners;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runners', { owner, repo, per_page: 100 });
    return data.runners as Array<{ id: number; name: string; status: string }>;
  }

  private async _deleteRunner(owner: string, repo: string, runnerId: number): Promise<void> {
    if (this.token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runners/${runnerId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      if (!res.ok && res.status !== 404) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
      return;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', { owner, repo, runner_id: runnerId });
  }

  private async _createRunnerToken(owner: string, repo: string): Promise<string> {
    if (this.token) {
      return this.createRunnerTokenWithPAT(owner, repo, this.token);
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    const { data } = await octokit.request(
      'POST /repos/{owner}/{repo}/actions/runners/registration-token',
      { owner, repo },
    );
    return data.token;
  }

  private async getInstallationId(owner: string): Promise<number> {
    const { data } = await this.app!.octokit.request('GET /orgs/{org}/installation', {
      org: owner,
    });
    return data.id;
  }

  private async createRunnerTokenWithPAT(owner: string, repo: string, token: string): Promise<string> {

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runners/registration-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const data = await res.json() as { token: string };
    return data.token;
  }
}

/** Routes GitHub API calls to per-org AppClients, falling back to a default. */
export class AppClientRegistry {
  private readonly clients = new Map<string, AppClient>();

  constructor(private readonly defaultClient: AppClient) {}

  static fromDefault(client: AppClient): AppClientRegistry {
    return new AppClientRegistry(client);
  }

  register(org: string, client: AppClient): void {
    this.clients.set(org.toLowerCase(), client);
  }

  clientFor(owner: string): AppClient {
    return this.clients.get(owner.toLowerCase()) ?? this.defaultClient;
  }
}
