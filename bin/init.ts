#!/usr/bin/env node
/**
 * burstgrid init — scaffold burstgrid.config.yaml from live AWS resources.
 *
 * Discovers launch templates named burstgrid-<size> and the subnets in
 * your most AZ-diverse VPC, then writes a ready-to-use config file.
 *
 * Usage:
 *   npx burstgrid init                  # writes ./burstgrid.config.yaml
 *   npx burstgrid init --out /path/to/burstgrid.config.yaml
 *   npx burstgrid init --region us-west-2
 */
import path from 'node:path';
import fs from 'node:fs';
import { discoverAWSResources, writeConfig } from '../src/init/index.js';

const args = process.argv.slice(2);
const regionIdx = args.indexOf('--region');
const region = regionIdx !== -1 ? args[regionIdx + 1] : process.env.AWS_REGION;
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1
  ? path.resolve(args[outIdx + 1])
  : path.join(process.cwd(), 'burstgrid.config.yaml');

if (fs.existsSync(outPath) && !args.includes('--force')) {
  console.error(`${outPath} already exists. Pass --force to overwrite.`);
  process.exit(1);
}

console.log(`Querying AWS${region ? ` (${region})` : ''}…`);

try {
  const result = await discoverAWSResources(region);

  if (result.fleets.length === 0) {
    console.warn(
      '\nNo launch templates found matching the burstgrid-<size> naming convention.\n' +
      'Create at least one to get started:\n\n' +
      '  aws ec2 create-launch-template \\\n' +
      '    --launch-template-name burstgrid-large \\\n' +
      '    --launch-template-data \'{"ImageId":"ami-XXXX","InstanceType":"m6g.2xlarge",...}\'\n\n' +
      'The template must include: AMI with worker-agent installed, IAM instance profile,\n' +
      'security group with outbound HTTPS, and user-data that starts burstgrid-worker-agent.\n\n' +
      'Writing config with placeholders so you can fill in IDs manually.\n',
    );
  } else {
    console.log(`Found ${result.fleets.length} template(s): ${result.fleets.map(f => f.name).join(', ')}`);
    if (result.missingTemplates.length) {
      console.log(`Placeholders added for: ${result.missingTemplates.join(', ')} (create templates to activate)`);
    }
  }

  if (result.allSubnetIds.length) {
    console.log(`Subnets: ${result.allSubnetIds.join(', ')}`);
  }

  writeConfig(result, outPath);
  console.log(`\nWrote ${outPath}`);
  console.log('Run `burstgrid validate` to confirm the config is valid.');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nAWS query failed: ${msg}`);
  console.error('Make sure AWS credentials are configured (AWS_PROFILE, instance role, or env vars).');
  process.exit(1);
}
