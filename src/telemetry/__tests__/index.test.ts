import { describe, it, expect, vi, afterEach } from 'vitest';
import { logEvent, logVmLine } from '../index.js';

describe('logEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefixes the message with the component and logs at the given level', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logEvent('queue', 'info', 'restored 3 jobs from Redis');
    expect(spy).toHaveBeenCalledWith('[queue] restored 3 jobs from Redis');
  });

  it('appends the error message when an err is passed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('pool', 'error', 'Redis worker upsert error:', new Error('connection refused'));
    expect(spy).toHaveBeenCalledWith('[pool] Redis worker upsert error: connection refused');
  });

  it('stringifies non-Error err values', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logEvent('autoscaler', 'warn', 'launch failed', 'ThrottlingException');
    expect(spy).toHaveBeenCalledWith('[autoscaler] launch failed ThrottlingException');
  });

  it('is a no-op toward OTel (does not throw) before initTelemetry() has run', () => {
    expect(() => logEvent('router', 'info', 'no otlp endpoint configured yet')).not.toThrow();
  });
});

describe('logVmLine', () => {
  it('no-ops before initTelemetry() has run', () => {
    expect(() => logVmLine({ jobId: 'j', vmId: 'v', workerId: 'w' }, 'boot line')).not.toThrow();
  });
});
