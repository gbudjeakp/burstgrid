import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FlociContainer, type StartedFlociContainer } from '@floci/testcontainers';
import { DynamoDBClient, CreateTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBJobHistory } from '../dynamodb.js';
import { ExecutionTier } from '../../types/index.js';

// Runs against a real Floci-emulated DynamoDB instead of a hand-mocked AWS SDK client,
// so a marshalling or API-shape bug can't hide behind a mock that drifted from reality.
describe('DynamoDBJobHistory (Floci integration)', () => {
  let floci: StartedFlociContainer;
  let originalEnv: Record<string, string | undefined>;
  const tableName = 'burstgrid-jobs-test';

  beforeAll(async () => {
    floci = await new FlociContainer().start();

    originalEnv = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    // DynamoDBJobHistory builds its own client with no endpoint override — the AWS SDK
    // reads AWS_ENDPOINT_URL/credentials from the environment, same as it would in prod.
    process.env.AWS_ENDPOINT_URL = floci.getEndpoint();
    process.env.AWS_ACCESS_KEY_ID = floci.getAccessKey();
    process.env.AWS_SECRET_ACCESS_KEY = floci.getSecretKey();

    const setup = new DynamoDBClient({ region: floci.getRegion() });
    await setup.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    setup.destroy();
  });

  afterAll(async () => {
    process.env.AWS_ENDPOINT_URL = originalEnv.AWS_ENDPOINT_URL;
    process.env.AWS_ACCESS_KEY_ID = originalEnv.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = originalEnv.AWS_SECRET_ACCESS_KEY;
    await floci.stop();
  });

  it('writes a job event that round-trips through real DynamoDB wire protocol', async () => {
    const history = new DynamoDBJobHistory(tableName, floci.getRegion());
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await history.record({
      jobId: 'job-1',
      status: 'queued',
      owner: 'acme',
      repo: 'widgets',
      runId: 42,
      tier: ExecutionTier.Standard,
      labels: ['self-hosted'],
      timestamp,
    });
    await history.close();

    const verify = new DynamoDBClient({ region: floci.getRegion() });
    const { Item } = await verify.send(new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: 'JOB#job-1' }, sk: { S: `${timestamp.toISOString()}#queued` } },
    }));
    verify.destroy();

    expect(Item?.jobId.S).toBe('job-1');
    expect(Item?.status.S).toBe('queued');
    expect(Item?.owner.S).toBe('acme');
    expect(Item?.labels.L?.map(v => v.S)).toEqual(['self-hosted']);
  });
});
