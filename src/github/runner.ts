import fs from 'node:fs';
import { App } from '@octokit/app';
import { logEvent, recordGithubRateLimit, recordGithubRateLimitExceeded } from '../telemetry/index.js';

export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  constructor() { super('GitHub API circuit breaker is open — request rejected until cooldown expires'); }
}

/** Thrown instead of a generic Error when GitHub rejects a call for exceeding a rate limit. */
export class RateLimitError extends Error {
  readonly isRateLimit = true;
  constructor(readonly resetAt: number, readonly kind: 'primary' | 'secondary') {
    super(`GitHub API ${kind} rate limit exceeded, resets at ${new Date(resetAt * 1000).toISOString()}`);
  }
}

type HeaderSource = Headers | Record<string, string | number | undefined> | undefined;

function header(headers: HeaderSource, key: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(key) ?? undefined;
  const value = headers[key];
  return value === undefined ? undefined : String(value);
}

/** Warn in logs once quota drops below this fraction of the window's total limit. */
const RATE_LIMIT_WARN_RATIO = 0.1;

/** Samples x-ratelimit-* headers off every GitHub response (success or failure) and exports them as gauges. */
function trackRateLimit(owner: string, headers: HeaderSource): void {
  const remaining = header(headers, 'x-ratelimit-remaining');
  const limit = header(headers, 'x-ratelimit-limit');
  if (remaining === undefined || limit === undefined) return;
  const remainingNum = Number(remaining);
  const limitNum = Number(limit);
  recordGithubRateLimit(owner, remainingNum, limitNum);
  if (limitNum > 0 && remainingNum / limitNum < RATE_LIMIT_WARN_RATIO) {
    logEvent('github', 'warn', `${owner}: GitHub API quota at ${remainingNum}/${limitNum} remaining`);
  }
}

/** Distinguishes a primary (quota exhausted) or secondary (abuse detection) rate limit from a plain error response. */
function rateLimitFromResponse(owner: string, status: number, headers: HeaderSource): RateLimitError | null {
  if (status !== 403 && status !== 429) return null;
  const remaining = header(headers, 'x-ratelimit-remaining');
  if (remaining === '0') {
    const resetAt = Number(header(headers, 'x-ratelimit-reset') ?? 0);
    recordGithubRateLimitExceeded(owner, 'primary');
    return new RateLimitError(resetAt, 'primary');
  }
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter !== undefined) {
    const resetAt = Math.floor(Date.now() / 1000) + Number(retryAfter);
    recordGithubRateLimitExceeded(owner, 'secondary');
    return new RateLimitError(resetAt, 'secondary');
  }
  return null;
}

/** Converts an octokit RequestError into a RateLimitError when its response is rate-limit-shaped, otherwise passes it through. */
function toRateLimitError(owner: string, err: unknown): unknown {
  const e = err as { status?: number; response?: { headers?: Record<string, string | undefined> } };
  if (typeof e.status === 'number' && e.response?.headers) {
    trackRateLimit(owner, e.response.headers);
    return rateLimitFromResponse(owner, e.status, e.response.headers) ?? err;
  }
  return err;
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
          logEvent('circuit-breaker', 'error', `GitHub API opened after ${this.failures} failures, cooldown ${this.cooldownMs}ms`);
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
      // A rate limit won't clear within a backoff window — retrying just burns more of the same quota.
      if (err instanceof RateLimitError || i === attempts) throw err;
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
        trackRateLimit(owner, res.headers);
        if (!res.ok) throw rateLimitFromResponse(owner, res.status, res.headers) ?? new Error(`GitHub API ${res.status}: ${await res.text()}`);
        const data = await res.json() as { workflow_runs: Array<{ id: number }> };
        return data.workflow_runs;
      }
      const installationId = await this.getInstallationId(owner);
      const octokit = await this.app!.getInstallationOctokit(installationId);
      try {
        const { data, headers } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
          owner, repo, status: status as 'queued' | 'in_progress', per_page: 50,
        });
        trackRateLimit(owner, headers);
        return data.workflow_runs as Array<{ id: number }>;
      } catch (err) {
        throw toRateLimitError(owner, err);
      }
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
      trackRateLimit(owner, res.headers);
      if (!res.ok) throw rateLimitFromResponse(owner, res.status, res.headers) ?? new Error(`GitHub API ${res.status}: ${await res.text()}`);
      const data = await res.json() as { jobs: Array<{ id: number; status: string; labels: string[] }> };
      return data.jobs;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    try {
      const { data, headers } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
        owner, repo, run_id: runId, filter: 'latest', per_page: 100,
      });
      trackRateLimit(owner, headers);
      return data.jobs as Array<{ id: number; status: string; labels: string[] }>;
    } catch (err) {
      throw toRateLimitError(owner, err);
    }
  }

  private async _listRunners(owner: string, repo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    if (this.token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runners?per_page=100`,
        { headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      trackRateLimit(owner, res.headers);
      if (!res.ok) throw rateLimitFromResponse(owner, res.status, res.headers) ?? new Error(`GitHub API ${res.status}: ${await res.text()}`);
      const data = await res.json() as { runners: Array<{ id: number; name: string; status: string }> };
      return data.runners;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    try {
      const { data, headers } = await octokit.request('GET /repos/{owner}/{repo}/actions/runners', { owner, repo, per_page: 100 });
      trackRateLimit(owner, headers);
      return data.runners as Array<{ id: number; name: string; status: string }>;
    } catch (err) {
      throw toRateLimitError(owner, err);
    }
  }

  private async _deleteRunner(owner: string, repo: string, runnerId: number): Promise<void> {
    if (this.token) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runners/${runnerId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      trackRateLimit(owner, res.headers);
      if (!res.ok && res.status !== 404) throw rateLimitFromResponse(owner, res.status, res.headers) ?? new Error(`GitHub API ${res.status}: ${await res.text()}`);
      return;
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    try {
      const { headers } = await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', { owner, repo, runner_id: runnerId });
      trackRateLimit(owner, headers);
    } catch (err) {
      throw toRateLimitError(owner, err);
    }
  }

  private async _createRunnerToken(owner: string, repo: string): Promise<string> {
    if (this.token) {
      return this.createRunnerTokenWithPAT(owner, repo, this.token);
    }
    const installationId = await this.getInstallationId(owner);
    const octokit = await this.app!.getInstallationOctokit(installationId);
    try {
      const { data, headers } = await octokit.request(
        'POST /repos/{owner}/{repo}/actions/runners/registration-token',
        { owner, repo },
      );
      trackRateLimit(owner, headers);
      return data.token;
    } catch (err) {
      throw toRateLimitError(owner, err);
    }
  }

  private async getInstallationId(owner: string): Promise<number> {
    try {
      const { data, headers } = await this.app!.octokit.request('GET /orgs/{org}/installation', {
        org: owner,
      });
      trackRateLimit(owner, headers);
      return data.id;
    } catch (err) {
      throw toRateLimitError(owner, err);
    }
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
    trackRateLimit(owner, res.headers);
    if (!res.ok) throw rateLimitFromResponse(owner, res.status, res.headers) ?? new Error(`GitHub API ${res.status}: ${await res.text()}`);
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
