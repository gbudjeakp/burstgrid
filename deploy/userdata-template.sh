#!/usr/bin/env bash
set -euo pipefail
exec > >(tee /var/log/burstgrid-bootstrap.log) 2>&1

# ── IMDSv2 token ──────────────────────────────────────────────────────────────
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/instance-id")
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/placement/availability-zone")
REGION="${AZ%?}"

echo "[bootstrap] instance=$INSTANCE_ID az=$AZ region=$REGION"

# ── Release apt lock held by unattended-upgrades ──────────────────────────────
# Ubuntu 24.04 runs unattended-upgrades on boot and holds dpkg lock for 40-60 min
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl disable unattended-upgrades 2>/dev/null || true
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 2; done

# ── Base packages ─────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates unzip jq git \
  build-essential libssl-dev

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
# Must come before any `aws` calls (Ubuntu 24.04 does not ship AWS CLI)
ARCH=$(uname -m)
if [[ "$ARCH" == "aarch64" ]]; then
  CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"
else
  CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
fi
curl -fsSL "$CLI_URL" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2
/tmp/awscliv2/aws/install
rm -rf /tmp/awscliv2 /tmp/awscliv2.zip

# ── SSM agent (enables AWS Systems Manager access for debugging) ──────────────
snap install amazon-ssm-agent --classic 2>/dev/null || \
  apt-get install -y amazon-ssm-agent 2>/dev/null || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent 2>/dev/null || \
  systemctl enable --now amazon-ssm-agent 2>/dev/null || true

# ── Tag self with role for IAM self-terminate condition ───────────────────────
/usr/local/bin/aws ec2 create-tags --region "$REGION" \
  --resources "$INSTANCE_ID" \
  --tags "Key=burstgrid:role,Value=runner" || true

# ── Node.js 20 ───────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version

# ── GitHub Actions runner (ARM64) ────────────────────────────────────────────
RUNNER_VERSION="2.319.1"
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -fsSLO "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
tar xzf "actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
./bin/installdependencies.sh

# ── run.sh: called by worker-agent slot in process mode ──────────────────────
# Receives RUNNER_TOKEN, RUNNER_LABELS, RUNNER_EPHEMERAL from worker-agent
cat > /opt/actions-runner/burstgrid-run.sh << 'RUNSCRIPT'
#!/bin/bash
set -euo pipefail
cd /opt/actions-runner

# Clean up stale state from any previous run (config.sh remove needs a separate removal token)
rm -f .runner .credentials .env

./config.sh \
  --url "$RUNNER_REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --labels "$RUNNER_LABELS,self-hosted,linux,arm64" \
  --name "burstgrid-$(hostname)-$$" \
  --unattended \
  --ephemeral \
  --replace

./run.sh
RUNSCRIPT
chmod +x /opt/actions-runner/burstgrid-run.sh

# ── BurstGrid worker-agent ────────────────────────────────────────────────────
mkdir -p /opt/burstgrid
/usr/local/bin/aws s3 cp "s3://burstgrid-artifacts-284347454476/worker-agent.mjs" \
  /opt/burstgrid/worker-agent.mjs

# ── systemd service ───────────────────────────────────────────────────────────
cat > /etc/systemd/system/burstgrid-worker.service << EOF
[Unit]
Description=BurstGrid Worker Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=BURSTGRID_SCHEDULER_URL=SCHEDULER_URL_PLACEHOLDER
Environment=BURSTGRID_WORKER_ID=$INSTANCE_ID
Environment=BURSTGRID_SLOTS=SLOTS_PLACEHOLDER
Environment=BURSTGRID_MODE=process
Environment=BURSTGRID_RUNNER_PATH=/opt/actions-runner/burstgrid-run.sh
Environment=BURSTGRID_WORKER_TOKEN=WORKER_TOKEN_PLACEHOLDER
Environment=BURSTGRID_SPOT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/284347454476/burstgrid-spot-interruptions
Environment=AWS_AZ=$AZ
Environment=AWS_REGION=$REGION
ExecStart=/usr/bin/node /opt/burstgrid/worker-agent.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now burstgrid-worker
echo "[bootstrap] done"
