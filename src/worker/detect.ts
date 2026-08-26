import os from 'node:os';
import { execSync } from 'node:child_process';

export type ExecFn = (cmd: string, opts: { stdio: string; timeout: number }) => Buffer | string;
export type FetchFn = (url: string, init?: RequestInit) => Promise<{ ok: boolean; text(): Promise<string> }>;

export function detectCapabilities(
  arch: string = os.arch(),
  exec: ExecFn = execSync,
): string[] {
  const caps = ['linux', arch === 'arm64' ? 'arm64' : 'x86_64'];
  try { exec('docker info --format "{{.ID}}"', { stdio: 'pipe', timeout: 3_000 }); caps.push('docker'); } catch { /* not available */ }
  try { exec('nvidia-smi --query-gpu=name --format=csv,noheader', { stdio: 'pipe', timeout: 3_000 }); caps.push('gpu', 'cuda'); } catch { /* not available */ }
  return caps;
}

export async function detectWorkerId(
  fetchFn: FetchFn = globalThis.fetch,
  hostname: () => string = os.hostname.bind(os),
): Promise<string> {
  try {
    const res = await fetchFn('http://169.254.169.254/latest/meta-data/instance-id', {
      signal: AbortSignal.timeout(200),
    });
    if (res.ok) return res.text();
  } catch { /* not on EC2 */ }
  return hostname();
}
