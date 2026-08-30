import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Derive image name from the Dockerfile path — always the parent directory name. */
export function resolveImageName(dockerfilePath: string): string {
  return path.basename(path.dirname(path.resolve(dockerfilePath)));
}

/** Output .img path — explicit --out, or a temp path derived from name. */
export function resolveOutputPath(name: string, outOpt?: string): string {
  return outOpt ?? path.join(os.tmpdir(), 'burstgrid-images', `${name}.img`);
}

/** S3 key for the image — prefix defaults to 'rootfs/' if not provided. */
export function resolveS3Key(name: string, prefix: string): string {
  const p = prefix === '' ? 'rootfs/' : prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${name}.img`;
}

/** Read s3_artifacts_bucket from a terraform.tfvars file, if it exists. */
export function bucketFromTfvars(tfvarsDir: string): string | undefined {
  const tfvars = path.join(tfvarsDir, 'terraform.tfvars');
  if (!fs.existsSync(tfvars)) return undefined;
  const match = fs.readFileSync(tfvars, 'utf-8').match(/s3_artifacts_bucket\s*=\s*"([^"]+)"/);
  return match?.[1];
}
