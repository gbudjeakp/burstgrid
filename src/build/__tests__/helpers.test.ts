import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketFromTfvars, resolveImageName, resolveOutputPath, resolveS3Key } from '../index.js';

describe('resolveImageName', () => {
  it('uses parent directory name when path ends in Dockerfile', () => {
    expect(resolveImageName('rootfs/my-image/Dockerfile')).toBe('my-image');
  });

  it('uses parent directory name for variant Dockerfiles too', () => {
    expect(resolveImageName('rootfs/node20/Dockerfile.gpu')).toBe('node20');
  });

  it('works with absolute paths', () => {
    expect(resolveImageName('/opt/burstgrid/rootfs/ubuntu-ci/Dockerfile')).toBe('ubuntu-ci');
  });
});

describe('resolveOutputPath', () => {
  it('returns explicit --out value when provided', () => {
    expect(resolveOutputPath('my-image', '/custom/path.img')).toBe('/custom/path.img');
  });

  it('builds a tmp path from name when no override given', () => {
    const result = resolveOutputPath('my-image');
    expect(result).toContain('my-image.img');
    expect(result).toContain(os.tmpdir());
  });

  it('always ends in .img', () => {
    const result = resolveOutputPath('ubuntu-ci');
    expect(result.endsWith('.img')).toBe(true);
  });
});

describe('resolveS3Key', () => {
  it('prefixes with rootfs/ by default when prefix is empty string', () => {
    expect(resolveS3Key('my-image', '')).toBe('rootfs/my-image.img');
  });

  it('appends trailing slash to prefix without one', () => {
    expect(resolveS3Key('my-image', 'rootfs')).toBe('rootfs/my-image.img');
  });

  it('does not double slash when prefix already ends in /', () => {
    expect(resolveS3Key('my-image', 'rootfs/')).toBe('rootfs/my-image.img');
  });

  it('supports nested prefix paths', () => {
    expect(resolveS3Key('ubuntu-ci', 'images/rootfs')).toBe('images/rootfs/ubuntu-ci.img');
  });
});

describe('bucketFromTfvars', () => {
  it('returns undefined when directory does not contain terraform.tfvars', () => {
    expect(bucketFromTfvars('/nonexistent/dir')).toBeUndefined();
  });

  it('extracts s3_artifacts_bucket from tfvars content', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bg-test-'));
    try {
      await writeFile(
        path.join(dir, 'terraform.tfvars'),
        `aws_region          = "us-east-1"\ns3_artifacts_bucket = "my-test-bucket"\nworker_token = "secret"\n`,
      );
      expect(bucketFromTfvars(dir)).toBe('my-test-bucket');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns undefined when s3_artifacts_bucket is not present', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bg-test-'));
    try {
      await writeFile(path.join(dir, 'terraform.tfvars'), 'aws_region = "us-east-1"\n');
      expect(bucketFromTfvars(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
