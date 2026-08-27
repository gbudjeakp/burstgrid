import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { loadConfig } from '../index.js';

vi.mock('node:fs');
const mockFs = vi.mocked(fs);

afterEach(() => vi.restoreAllMocks());

function mockYaml(content: string): void {
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue(content);
}

describe('loadConfig', () => {
  it('returns empty object when config file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(loadConfig('/no/such/file.yaml')).toEqual({});
  });

  it('parses a valid minimal config', () => {
    mockYaml('scheduler:\n  maxQueueDepth: 200\n');
    const cfg = loadConfig('/fake.yaml');
    expect(cfg.scheduler?.maxQueueDepth).toBe(200);
  });

  it('parses drainTimeoutMs and watchdog timeouts', () => {
    mockYaml([
      'scheduler:',
      '  drainTimeoutMs: 120000',
      'worker:',
      '  dispatchTimeoutMs: 30000',
      '  jobTimeoutMs: 1800000',
    ].join('\n'));
    const cfg = loadConfig('/fake.yaml');
    expect(cfg.scheduler?.drainTimeoutMs).toBe(120_000);
    expect(cfg.worker?.dispatchTimeoutMs).toBe(30_000);
    expect(cfg.worker?.jobTimeoutMs).toBe(1_800_000);
  });

  it('exits with code 1 on an unknown top-level key', () => {
    mockYaml('unknownKey: bad\n');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    expect(() => loadConfig('/fake.yaml')).toThrow('process.exit called');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 on a wrong-type field', () => {
    mockYaml('scheduler:\n  maxQueueDepth: "not-a-number"\n');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    expect(() => loadConfig('/fake.yaml')).toThrow('process.exit called');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 on a YAML parse error', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{ invalid yaml: [[[');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    expect(() => loadConfig('/fake.yaml')).toThrow('process.exit called');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
