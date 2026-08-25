import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { IJobHistoryBackend, JobEvent } from './types.js';

/**
 * Writes job lifecycle events to a DynamoDB table.
 *
 * Expected table schema:
 *   PK (S): JOB#<jobId>
 *   SK (S): <ISO timestamp>#<status>
 *
 * Create with:
 *   aws dynamodb create-table \
 *     --table-name burstgrid-jobs \
 *     --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
 *     --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
 *     --billing-mode PAY_PER_REQUEST
 */
export class DynamoDBJobHistory implements IJobHistoryBackend {
  private readonly client: DynamoDBClient;

  constructor(
    private readonly tableName: string,
    region: string,
  ) {
    this.client = new DynamoDBClient({ region });
  }

  async record(event: JobEvent): Promise<void> {
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: marshall({
          pk:                `JOB#${event.jobId}`,
          sk:                `${event.timestamp.toISOString()}#${event.status}`,
          jobId:             event.jobId,
          status:            event.status,
          owner:             event.owner,
          repo:              event.repo,
          runId:             event.runId,
          tier:              event.tier,
          labels:            event.labels,
          timestamp:         event.timestamp.toISOString(),
          ...(event.workerId          && { workerId: event.workerId }),
          ...(event.dispatchLatencyMs && { dispatchLatencyMs: event.dispatchLatencyMs }),
        }, { removeUndefinedValues: true }),
      }));
    } catch (err) {
      console.error('[dynamo] failed to record job event', err);
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
