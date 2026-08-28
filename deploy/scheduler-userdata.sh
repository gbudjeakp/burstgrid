#!/usr/bin/env bash
# BurstGrid scheduler EC2 bootstrap
set -euo pipefail
exec > >(tee /var/log/burstgrid-scheduler-boot.log) 2>&1

BUCKET="burstgrid-artifacts-284347454476"
WORKDIR="/opt/burstgrid"

# ── AWS CLI v2 (ARM64) ─────────────────────────────────────────────────────────
apt-get update -y
apt-get install -y unzip curl
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# ── Node.js 20 (via NodeSource) ────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── Download artifacts ─────────────────────────────────────────────────────────
mkdir -p "$WORKDIR"
/usr/local/bin/aws s3 cp "s3://$BUCKET/scheduler.mjs"         "$WORKDIR/scheduler.mjs"
/usr/local/bin/aws s3 cp "s3://$BUCKET/burstgrid.config.yaml" "$WORKDIR/burstgrid.config.yaml"

# ── Environment ────────────────────────────────────────────────────────────────
cat > "$WORKDIR/.env" << 'ENVEOF'
BURSTGRID_CONFIG=/opt/burstgrid/burstgrid.config.yaml
GITHUB_TOKEN=GITHUB_TOKEN_PLACEHOLDER
BURSTGRID_WEBHOOK_SECRET=WEBHOOK_SECRET_PLACEHOLDER
BURSTGRID_WORKER_TOKEN=WORKER_TOKEN_PLACEHOLDER
AWS_REGION=us-east-1
BURSTGRID_SPOT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/284347454476/burstgrid-spot-interruptions
BURSTGRID_PORT=8080
BURSTGRID_ADDR=0.0.0.0
ENVEOF
chmod 600 "$WORKDIR/.env"

# ── Systemd service ────────────────────────────────────────────────────────────
cat > /etc/systemd/system/burstgrid-scheduler.service << 'SVCEOF'
[Unit]
Description=BurstGrid Scheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/burstgrid
EnvironmentFile=/opt/burstgrid/.env
ExecStart=/usr/bin/node /opt/burstgrid/scheduler.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now burstgrid-scheduler
echo "BurstGrid scheduler started"
