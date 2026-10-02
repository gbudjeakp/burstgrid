import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FlociContainer, type StartedFlociContainer } from '@floci/testcontainers';
import { SQSClient, CreateQueueCommand, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SQSJobPoller } from '../sqs.js';
import { JobQueue } from '../../scheduler/queue.js';

// Runs the poller's long-poll/parse/delete cycle against a real Floci-emulated SQS queue
// instead of a hand-mocked client, catching drift between the mock and the real wire protocol.
describe('SQSJobPoller (Floci integration)', () => {
  let floci: StartedFlociContainer;
  let originalEnv: Record<string, string | undefined>;
  let queueUrl: string;

  beforeAll(async () => {
    floci = await new FlociContainer().start();

    originalEnv = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    // SQSJobPoller builds its own client with no endpoint override — the AWS SDK reads
    // AWS_ENDPOINT_URL/credentials from the environment, same as it would in prod.
    process.env.AWS_ENDPOINT_URL = floci.getEndpoint();
    process.env.AWS_ACCESS_KEY_ID = floci.getAccessKey();
    process.env.AWS_SECRET_ACCESS_KEY = floci.getSecretKey();

    const setup = new SQSClient({ region: floci.getRegion() });
    const { QueueUrl } = await setup.send(new CreateQueueCommand({ QueueName: 'burstgrid-jobs-test' }));
    queueUrl = QueueUrl!;
    setup.destroy();
  });

  afterAll(async () => {
    process.env.AWS_ENDPOINT_URL = originalEnv.AWS_ENDPOINT_URL;
    process.env.AWS_ACCESS_KEY_ID = originalEnv.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = originalEnv.AWS_SECRET_ACCESS_KEY;
    await floci.stop();
  });

  it('polls a real queue, enqueues the job, and deletes the message', async () => {
    const send = new SQSClient({ region: floci.getRegion(), useQueueUrlAsEndpoint: false });
    await send.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        id: 'job-1', owner: 'acme', repo: 'widgets', runId: 42,
        labels: ['self-hosted'], runnerToken: 'tok-abc',
      }),
    }));

    const queue = new JobQueue();
    const poller = new SQSJobPoller({ queueUrl, region: floci.getRegion() }, queue);
    poller.start();

    await expect.poll(() => queue.depth, { timeout: 30_000 }).toBe(1);
    poller.stop();

    const attrs = await send.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    send.destroy();

    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0');
  });
});
