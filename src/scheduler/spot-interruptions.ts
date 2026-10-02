import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { JobQueue } from './queue.js';
import type { WorkerPool } from './worker-pool.js';
import type { Autoscaler } from '../fleet/autoscaler.js';
import { logEvent, recordSpotSignal } from '../telemetry/index.js';

interface SpotInterruptionEvent {
  'detail-type'?: string;
  time?: string;
  detail?: {
    'instance-id'?: string;
  };
}

/**
 * Centralized spot capacity-risk consumer: one scheduler drains the SQS queue and reacts to
 * both signals AWS can send ahead of reclaiming a spot instance.
 *
 * - "EC2 Instance Rebalance Recommendation" is a soft, earlier warning — AWS thinks this
 *   instance is at elevated interruption risk but gives no guaranteed follow-up or timeline.
 *   Treated as a cordon: stop placing new jobs here, leave what's already running alone, and
 *   immediately ask the autoscaler for replacement capacity instead of waiting on a timer.
 * - "EC2 Spot Instance Interruption Warning" is the hard ~2-minute notice. Treated as before:
 *   drain the worker's tracked jobs now and requeue them.
 */
export class SpotInterruptionMonitor {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    private readonly pool: WorkerPool,
    private readonly queue: JobQueue,
    private readonly autoscaler?: Autoscaler,
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
            await this.handleMessage(msg.Body ?? '');
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

  private async handleMessage(body: string): Promise<void> {
    const event = JSON.parse(body) as SpotInterruptionEvent;
    const detailType = event['detail-type'];
    if (detailType !== 'EC2 Spot Instance Interruption Warning' && detailType !== 'EC2 Instance Rebalance Recommendation') return;

    const instanceId = event.detail?.['instance-id'];
    if (!instanceId) {
      logEvent('spot', 'warn', `${detailType} missing instance-id`);
      return;
    }

    if (detailType === 'EC2 Instance Rebalance Recommendation') {
      recordSpotSignal('rebalance');
      const workerId = this.pool.findWorkerByEc2InstanceId(instanceId);
      if (!workerId) {
        logEvent('spot', 'warn', `rebalance recommendation for unknown worker instance ${instanceId}`);
        return;
      }
      this.pool.cordon(workerId);
      logEvent('spot', 'warn', `rebalance recommendation for ${instanceId} (${workerId}) — cordoned, requesting replacement capacity now`);
      await this.autoscaler?.triggerEvaluation();
      return;
    }

    recordSpotSignal('interruption');
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
