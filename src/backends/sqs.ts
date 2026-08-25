import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { ExecutionTier, type Job } from '../types/index.js';
import { selectTier } from '../scheduler/router.js';
import type { JobQueue } from '../scheduler/queue.js';

export interface SQSPollerOptions {
  queueUrl: string;
  region: string;
}

/** Polls an SQS queue and enqueues messages as Jobs. Message body must be a JSON Job object. */
export class SQSJobPoller {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly opts: SQSPollerOptions,
    private readonly queue: JobQueue,
  ) {
    this.client = new SQSClient({ region: opts.region });
  }

  start(): void {
    this.running = true;
    void this.poll();
    console.info(`[sqs] polling ${this.opts.queueUrl}`);
  }

  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.client.send(new ReceiveMessageCommand({
          QueueUrl:            this.opts.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds:     20, // long polling
        }));

        for (const msg of result.Messages ?? []) {
          try {
            const partial = JSON.parse(msg.Body!) as Partial<Job>;
            if (!partial.id || !partial.owner || !partial.repo || partial.runId === undefined) {
              console.warn('[sqs] dropping malformed message', msg.MessageId);
            } else {
              const job: Job = {
                id:          partial.id,
                owner:       partial.owner,
                repo:        partial.repo,
                runId:       partial.runId,
                labels:      partial.labels ?? [],
                tier:        partial.tier ?? selectTier(partial.labels ?? []),
                queuedAt:    new Date(partial.queuedAt ?? Date.now()),
                runnerToken: partial.runnerToken ?? '',
              };
              this.queue.enqueue(job);
            }
            // Delete regardless — malformed messages should not reappear
            await this.client.send(new DeleteMessageCommand({
              QueueUrl:      this.opts.queueUrl,
              ReceiptHandle: msg.ReceiptHandle!,
            }));
          } catch (err) {
            console.error('[sqs] message processing error', err);
          }
        }
      } catch (err) {
        console.error('[sqs] receive error, retrying in 5 s', err);
        await sleep(5_000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
