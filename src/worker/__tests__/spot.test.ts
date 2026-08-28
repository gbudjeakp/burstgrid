import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotMonitor } from '../spot.js';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class MockSQSClient { send = mockSend; },
  ReceiveMessageCommand: class MockReceiveMessageCommand { constructor(public input: unknown) {} },
  DeleteMessageCommand:  class MockDeleteMessageCommand  { constructor(public input: unknown) {} },
}));

/** Flush all pending microtasks without spinning the event loop infinitely. */
const flush = () => new Promise<void>(r => setImmediate(r));

/** A promise that never resolves — used to park the listen() loop after the first batch. */
const park = new Promise(() => {});

function makeInterruptionEvent(instanceId = 'i-1234', terminationTime = '2026-08-27T20:00:00Z'): string {
  return JSON.stringify({
    'detail-type': 'EC2 Spot Instance Interruption Warning',
    source: 'aws.ec2',
    detail: { instanceId, terminationTime },
  });
}

describe('SpotMonitor', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('emits terminating with detail when an interruption message arrives', async () => {
    mockSend
      .mockResolvedValueOnce({ Messages: [{ Body: makeInterruptionEvent(), ReceiptHandle: 'rh-1' }] })
      .mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    const received: unknown[] = [];
    monitor.on('terminating', detail => received.push(detail));
    monitor.start();

    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ instanceId: 'i-1234', terminationTime: '2026-08-27T20:00:00Z' });
    monitor.stop();
  });

  it('ignores messages with a non-matching detail-type', async () => {
    const unrelated = JSON.stringify({ 'detail-type': 'EC2 Instance State-change Notification', detail: {} });
    mockSend
      .mockResolvedValueOnce({ Messages: [{ Body: unrelated, ReceiptHandle: 'rh-2' }] })
      .mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    const received: unknown[] = [];
    monitor.on('terminating', d => received.push(d));
    monitor.start();

    await flush();

    expect(received).toHaveLength(0);
    monitor.stop();
  });

  it('deletes the SQS message after processing', async () => {
    mockSend
      .mockResolvedValueOnce({ Messages: [{ Body: makeInterruptionEvent(), ReceiptHandle: 'rh-del' }] })
      .mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    monitor.start();

    await flush();

    const deleteCall = mockSend.mock.calls.find(
      ([cmd]: [{ input?: { ReceiptHandle?: string } }]) => cmd?.input?.ReceiptHandle === 'rh-del',
    );
    expect(deleteCall).toBeDefined();
    monitor.stop();
  });

  it('emits error and retries when SQS throws', async () => {
    vi.useFakeTimers();

    let unblockRetry!: () => void;
    const retryBlocker = new Promise<{ Messages: never[] }>(r => { unblockRetry = () => r({ Messages: [] }); });

    mockSend
      .mockRejectedValueOnce(new Error('network error'))
      .mockReturnValueOnce(retryBlocker)
      .mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    const errors: Error[] = [];
    monitor.on('error', e => errors.push(e));
    monitor.start();

    // Let the rejected promise propagate through the async catch block
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('network error');

    // Advance past the 5 s retry sleep; the second ReceiveMessage should start
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);

    monitor.stop();
    unblockRetry();
    vi.useRealTimers();
  });

  it('stop() prevents further ReceiveMessage calls', async () => {
    let unblock!: () => void;
    const firstCall = new Promise<{ Messages: never[] }>(r => { unblock = () => r({ Messages: [] }); });
    mockSend.mockReturnValueOnce(firstCall).mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    monitor.start();

    // stop() before the first call resolves
    monitor.stop();
    unblock(); // let the in-flight call complete so the loop can check while(running)

    await flush();

    // Loop saw running=false and exited; no second call was made
    expect(mockSend.mock.calls.length).toBe(1);
  });

  it('start() is idempotent — calling it twice does not double-listen', async () => {
    let unblock!: () => void;
    const firstCall = new Promise<{ Messages: never[] }>(r => { unblock = () => r({ Messages: [] }); });
    mockSend.mockReturnValueOnce(firstCall).mockReturnValue(park);

    const monitor = new SpotMonitor('https://sqs.us-east-1.amazonaws.com/123/spot');
    monitor.start();
    monitor.start(); // no-op — already running

    // Only one ReceiveMessage should be in flight, not two
    expect(mockSend.mock.calls.length).toBe(1);

    monitor.stop();
    unblock();
    await flush();
  });
});
