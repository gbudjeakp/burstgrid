import {
  EC2Client,
  DescribeLaunchTemplatesCommand,
  DescribeSubnetsCommand,
} from '@aws-sdk/client-ec2';
import fs from 'node:fs';
import path from 'node:path';

// Canonical fleet sizes and their recommended defaults
const FLEET_DEFAULTS: Record<string, { slotsPerWorker: number; maxWorkers: number; scaleUpThreshold: number; sizeTag: string }> = {
  medium:  { slotsPerWorker: 2, maxWorkers: 5,  scaleUpThreshold: 1, sizeTag: 'burstgrid:size=medium' },
  large:   { slotsPerWorker: 4, maxWorkers: 10, scaleUpThreshold: 2, sizeTag: 'burstgrid:size=large' },
  xlarge:  { slotsPerWorker: 8, maxWorkers: 5,  scaleUpThreshold: 1, sizeTag: 'burstgrid:size=xlarge' },
  '2xlarge': { slotsPerWorker: 2, maxWorkers: 3, scaleUpThreshold: 1, sizeTag: 'burstgrid:size=2xlarge' },
};

interface DiscoveredFleet {
  name: string;
  launchTemplateId: string;
  subnetIds: string[];
}

interface InitResult {
  fleets: DiscoveredFleet[];
  allSubnetIds: string[];
  missingTemplates: string[];
}

/**
 * Queries AWS for launch templates named burstgrid-<size> and the subnets
 * in the most AZ-diverse VPC, returning everything needed to write the config.
 */
export async function discoverAWSResources(region?: string): Promise<InitResult> {
  const ec2 = new EC2Client({ region });

  // Discover launch templates matching burstgrid-<size> naming convention
  const ltRes = await ec2.send(new DescribeLaunchTemplatesCommand({
    Filters: [{ Name: 'launch-template-name', Values: ['burstgrid-*'] }],
  }));
  const foundTemplates = new Map<string, string>(); // size → templateId
  for (const lt of ltRes.LaunchTemplates ?? []) {
    const name = lt.LaunchTemplateName ?? '';
    const size = name.replace(/^burstgrid-/, '');
    if (size in FLEET_DEFAULTS) {
      foundTemplates.set(size, lt.LaunchTemplateId!);
    }
  }

  // Discover subnets — pick the VPC with the most AZ coverage
  const subnetRes = await ec2.send(new DescribeSubnetsCommand({}));
  const subnetsByVpc = new Map<string, Array<{ id: string; az: string; isDefault: boolean }>>();
  for (const s of subnetRes.Subnets ?? []) {
    const vpcId = s.VpcId ?? 'unknown';
    const list = subnetsByVpc.get(vpcId) ?? [];
    list.push({ id: s.SubnetId!, az: s.AvailabilityZone!, isDefault: s.DefaultForAz ?? false });
    subnetsByVpc.set(vpcId, list);
  }

  // Prefer the VPC with the most unique AZs (broadest spot fallback coverage)
  let bestVpcSubnets: typeof subnetsByVpc extends Map<string, infer V> ? V : never = [];
  let bestAzCount = 0;
  for (const [, subnets] of subnetsByVpc) {
    const azCount = new Set(subnets.map(s => s.az)).size;
    if (azCount > bestAzCount || (azCount === bestAzCount && subnets.some(s => s.isDefault))) {
      bestAzCount = azCount;
      bestVpcSubnets = subnets;
    }
  }

  // One subnet per AZ — prefer default subnets, then alphabetical by subnet ID
  const subnetByAz = new Map<string, string>();
  for (const s of bestVpcSubnets.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0))) {
    if (!subnetByAz.has(s.az)) subnetByAz.set(s.az, s.id);
  }
  const allSubnetIds = [...subnetByAz.values()];

  const missingTemplates = Object.keys(FLEET_DEFAULTS).filter(s => !foundTemplates.has(s));

  const fleets: DiscoveredFleet[] = [...foundTemplates.entries()].map(([size, ltId]) => ({
    name: size,
    launchTemplateId: ltId,
    subnetIds: allSubnetIds,
  }));

  return { fleets, allSubnetIds, missingTemplates };
}

function renderFleet(fleet: DiscoveredFleet): string {
  const d = FLEET_DEFAULTS[fleet.name];
  const subnetLines = fleet.subnetIds.map(id => `        - ${id}`).join('\n');
  return `    - name: ${fleet.name}
      sizeTag: "${d.sizeTag}"
      launchTemplateId: ${fleet.launchTemplateId}
      subnetIds:
${subnetLines}
      maxWorkers: ${d.maxWorkers}
      slotsPerWorker: ${d.slotsPerWorker}
      scaleUpThreshold: ${d.scaleUpThreshold}
      capacityType: spot`;
}

function renderPlaceholderFleet(size: string, subnetIds: string[]): string {
  const d = FLEET_DEFAULTS[size];
  const subnetLines = subnetIds.length
    ? subnetIds.map(id => `        - ${id}`).join('\n')
    : '        # run: aws ec2 describe-subnets --query "Subnets[*].SubnetId"';
  return `    # - name: ${size}
    #   sizeTag: "${d.sizeTag}"
    #   launchTemplateId: REPLACE_ME  # create: aws ec2 create-launch-template --launch-template-name burstgrid-${size} ...
    #   subnetIds:
${subnetLines.split('\n').map(l => `    #   ${l.trimStart()}`).join('\n')}
    #   maxWorkers: ${d.maxWorkers}
    #   slotsPerWorker: ${d.slotsPerWorker}
    #   scaleUpThreshold: ${d.scaleUpThreshold}
    #   capacityType: spot`;
}

/** Write (or print) a burstgrid.config.yaml populated with discovered AWS resource IDs. */
export function writeConfig(result: InitResult, outPath: string): void {
  const activeFleets = result.fleets.map(renderFleet).join('\n\n');
  const placeholders = result.missingTemplates
    .map(s => renderPlaceholderFleet(s, result.allSubnetIds))
    .join('\n\n');

  const fleetBlock = [
    activeFleets,
    placeholders ? '\n    # ── Templates not yet found in AWS (create to activate) ──────────\n' + placeholders : '',
  ].filter(Boolean).join('\n');

  const yaml = `# BurstGrid configuration — generated by \`burstgrid init\`
# Edit values as needed, then run \`burstgrid validate\` to check.

scheduler:
  maxQueueDepth: 500

autoscaler:
  enabled: true
  evaluationIntervalSec: 30

  fleets:
    # Launch templates are auto-discovered from AWS by the name pattern burstgrid-<size>.
    # To add a size: create a template named burstgrid-<size>, then re-run \`burstgrid init\`.
${fleetBlock}

# backends:
#   redis:
#     url: redis://your-elasticache.abc123.use1.cache.amazonaws.com:6379
`;

  fs.writeFileSync(outPath, yaml, 'utf8');
}
