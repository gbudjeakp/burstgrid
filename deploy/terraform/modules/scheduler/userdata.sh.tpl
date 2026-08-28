#!/usr/bin/env bash
# BurstGrid scheduler — EC2 bootstrap (Ubuntu 24.04 ARM64 / AMD64)
set -euo pipefail
exec > >(tee /var/log/burstgrid-scheduler-boot.log) 2>&1

BUCKET="${s3_artifacts_bucket}"
WORKDIR="/opt/burstgrid"

# ── Base packages ──────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends curl ca-certificates unzip

# ── AWS CLI v2 ────────────────────────────────────────────────────────────────
# Detect arch so the same template works on ARM64 and AMD64 instances
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

# ── Node.js 20 (NodeSource) ───────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── Download artifacts from S3 ────────────────────────────────────────────────
mkdir -p "$WORKDIR"
/usr/local/bin/aws s3 cp "s3://$BUCKET/scheduler.mjs" "$WORKDIR/scheduler.mjs"

# ── Environment file ──────────────────────────────────────────────────────────
cat > "$WORKDIR/.env" << 'ENVEOF'
BURSTGRID_PORT=8080
BURSTGRID_ADDR=0.0.0.0
AWS_REGION=${aws_region}
BURSTGRID_WEBHOOK_SECRET=${webhook_secret}
BURSTGRID_WORKER_TOKEN=${worker_token}
BURSTGRID_SPOT_QUEUE_URL=${spot_queue_url}
BURSTGRID_FLEETS=${burstgrid_fleets}
%{ if github_token != "" ~}
GITHUB_TOKEN=${github_token}
%{ else ~}
GITHUB_APP_ID=${github_app_id}
%{ endif ~}
ENVEOF
chmod 600 "$WORKDIR/.env"

# ── Systemd service ───────────────────────────────────────────────────────────
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
echo "[bootstrap] scheduler started"
