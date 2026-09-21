import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { JobQueue } from './queue.js';
import type { WorkerPool } from './worker-pool.js';
import { logEvent } from '../telemetry/index.js';

interface SpotInterruptionEvent {
  'detail-type'?: string;
  time?: string;
  detail?: {
    'instance-id'?: string;
  };
}

/** Centralized spot interruption consumer: one scheduler drains the queue and requeues affected jobs. */
export class SpotInterruptionMonitor {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    private readonly pool: WorkerPool,
    private readonly queue: JobQueue,
    region = process.env.AWS_REGION ?? 'us-east-1',
  ) {
    this.client = new SQSClient({ region });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    logEvent('spot', 'info', 'scheduler spot interruption monitor started');
  }

  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.client.send(new ReceiveMessageCommand({
          QueueUrl:            this.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds:     20,
        }));

        for (const msg of result.Messages ?? []) {
          try {
            this.handleMessage(msg.Body ?? '');
          } catch (err) {
            logEvent('spot', 'error', 'spot interruption message handling failed', err);
          } finally {
            if (msg.ReceiptHandle) {
              await this.client.send(new DeleteMessageCommand({
                QueueUrl:      this.queueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }));
            }
          }
        }
      } catch (err) {
        if (!this.running) return;
        logEvent('spot', 'error', 'spot interruption receive error, retrying in 5 s', err);
        await sleep(5_000);
      }
    }
  }

  private handleMessage(body: string): void {
    const event = JSON.parse(body) as SpotInterruptionEvent;
    if (event['detail-type'] !== 'EC2 Spot Instance Interruption Warning') return;

    const instanceId = event.detail?.['instance-id'];
    if (!instanceId) {
      logEvent('spot', 'warn', 'spot interruption warning missing instance-id');
      return;
    }

    const evicted = this.pool.evictByEc2InstanceId(instanceId);
    if (!evicted) {
      logEvent('spot', 'warn', `spot interruption for unknown worker instance ${instanceId}`);
      return;
    }

    for (const job of evicted.jobs) this.queue.requeue(job);
    logEvent('spot', 'warn', `interruption for ${instanceId} (${evicted.workerId}) at ${event.time ?? 'unknown'} — requeued ${evicted.jobs.length} job(s)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
