import { EventEmitter } from 'node:events';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

export interface SpotTerminationDetail {
  instanceId: string;
  terminationTime: string;
}

export interface SpotMonitorEvents {
  terminating: [detail: SpotTerminationDetail];
  error: [err: Error];
}

/**
 * Listens for EC2 spot interruption warnings via SQS long-poll.
 *
 * Setup: create an EventBridge rule matching
 *   { source: ['aws.ec2'], detail-type: ['EC2 Spot Instance Interruption Warning'] }
 * and route it to an SQS queue. Pass that queue URL as BURSTGRID_SPOT_QUEUE_URL.
 *
 * The SQS ReceiveMessage call uses WaitTimeSeconds=20 — AWS holds the connection open
 * and responds only when an event arrives, so no polling timer is needed.
 */
export class SpotMonitor extends EventEmitter {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    region = process.env.AWS_REGION ?? 'us-east-1',
  ) {
    super();
    this.client = new SQSClient({ region });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.listen();
  }

  stop(): void {
    this.running = false;
  }

  private async listen(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.client.send(new ReceiveMessageCommand({
          QueueUrl:            this.queueUrl,
          MaxNumberOfMessages: 1,
          // Blocks up to 20 s — AWS responds as soon as an event arrives
          WaitTimeSeconds:     20,
        }));

        for (const msg of result.Messages ?? []) {
          try {
            await this.handleMessage(msg.Body ?? '');
          } catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
          } finally {
            await this.client.send(new DeleteMessageCommand({
              QueueUrl:      this.queueUrl,
              ReceiptHandle: msg.ReceiptHandle!,
            }));
          }
        }
      } catch (err) {
        if (!this.running) return;
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        await sleep(5_000);
      }
    }
  }

  private handleMessage(body: string): void {
    const event = JSON.parse(body) as Record<string, unknown>;
    if (event['detail-type'] !== 'EC2 Spot Instance Interruption Warning') return;

    const detail = event['detail'] as SpotTerminationDetail;
    console.warn(`[spot] interruption warning — instance ${detail.instanceId} terminates at ${detail.terminationTime}`);
    this.emit('terminating', detail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
