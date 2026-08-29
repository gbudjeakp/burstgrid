#!/usr/bin/env bash
# BurstGrid worker agent — EC2 bootstrap (Ubuntu 24.04 ARM64)
set -euo pipefail
exec > >(tee /var/log/burstgrid-bootstrap.log) 2>&1

BUCKET="${s3_artifacts_bucket}"
RUNNER_VERSION="2.319.1"

# ── IMDSv2: resolve instance metadata ────────────────────────────────────────
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/instance-id")
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/placement/availability-zone")
REGION="${aws_region}"

echo "[bootstrap] instance=$INSTANCE_ID az=$AZ region=$REGION"

# ── Base packages ─────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates unzip git jq build-essential libssl-dev

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
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

# ── Tag self with role (enables self-terminate IAM condition) ─────────────────
/usr/local/bin/aws ec2 create-tags --region "$REGION" \
  --resources "$INSTANCE_ID" \
  --tags "Key=burstgrid:role,Value=runner" || true

# ── Node.js 20 ────────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── GitHub Actions runner (ARM64) ─────────────────────────────────────────────
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -fsSLO \
  "https://github.com/actions/runner/releases/download/v$${RUNNER_VERSION}/actions-runner-linux-arm64-$${RUNNER_VERSION}.tar.gz"
tar xzf "actions-runner-linux-arm64-$${RUNNER_VERSION}.tar.gz"
./bin/installdependencies.sh

# Called by the worker-agent slot; receives RUNNER_TOKEN and RUNNER_LABELS as env vars
cat > /opt/actions-runner/burstgrid-run.sh << 'RUNSCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd "${RUNNER_SLOT_DIR:-/opt/actions-runner}"
# Clean up stale state (config.sh remove requires a separate removal token)
rm -f .runner .credentials .env
./config.sh \
  --url "$RUNNER_REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --labels "$RUNNER_LABELS,self-hosted,linux,arm64" \
  --name "burstgrid-$(hostname)-$$" \
  --unattended --ephemeral --replace
./run.sh
RUNSCRIPT
chmod +x /opt/actions-runner/burstgrid-run.sh

# Create per-slot runner directories using hard links (no extra disk space)
for i in $(seq 0 $(($${slots_per_worker} - 1))); do
  cp -al /opt/actions-runner /opt/actions-runner-$i
  rm -f /opt/actions-runner-$i/.runner /opt/actions-runner-$i/.credentials /opt/actions-runner-$i/.env
  cp /opt/actions-runner/burstgrid-run.sh /opt/actions-runner-$i/burstgrid-run.sh
done

# ── BurstGrid worker-agent ────────────────────────────────────────────────────
mkdir -p /opt/burstgrid
/usr/local/bin/aws s3 cp "s3://$BUCKET/worker-agent.mjs" /opt/burstgrid/worker-agent.mjs

# ── Systemd service ───────────────────────────────────────────────────────────
cat > /etc/systemd/system/burstgrid-worker.service << EOF
[Unit]
Description=BurstGrid Worker Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=BURSTGRID_SCHEDULER_URL=${scheduler_url}
Environment=BURSTGRID_WORKER_ID=$INSTANCE_ID
Environment=BURSTGRID_SLOTS=${slots_per_worker}
Environment=BURSTGRID_MODE=process
Environment=BURSTGRID_RUNNER_PATH=/opt/actions-runner/burstgrid-run.sh
Environment=BURSTGRID_WORKER_TOKEN=${worker_token}
Environment=BURSTGRID_SPOT_QUEUE_URL=${spot_queue_url}
Environment=AWS_REGION=$REGION
Environment=AWS_AZ=$AZ
ExecStart=/usr/bin/node /opt/burstgrid/worker-agent.mjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now burstgrid-worker
echo "[bootstrap] worker-agent started"
