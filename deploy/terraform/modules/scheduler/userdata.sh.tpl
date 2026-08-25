#!/bin/bash
set -euo pipefail

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

# Download and install BurstGrid scheduler
curl -fsSL https://github.com/burstgrid/burstgrid/releases/latest/download/scheduler.tar.gz \
  | tar -C /usr/local/bin -xz scheduler

useradd -r -s /sbin/nologin burstgrid || true
mkdir -p /etc/burstgrid

# GitHub App private key is stored in SSM Parameter Store; fetch it at boot
aws ssm get-parameter \
  --name "/burstgrid/github-app-private-key" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text > /etc/burstgrid/github-app.pem
chmod 600 /etc/burstgrid/github-app.pem
chown burstgrid:burstgrid /etc/burstgrid/github-app.pem

cat > /etc/systemd/system/burstgrid-scheduler.service << 'EOF'
[Unit]
Description=BurstGrid Scheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=burstgrid
EnvironmentFile=/etc/burstgrid/scheduler.env
ExecStart=/usr/local/bin/scheduler
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/burstgrid/scheduler.env << ENVEOF
BURSTGRID_PORT=8080
BURSTGRID_WEBHOOK_SECRET=${webhook_secret}
GITHUB_APP_ID=${github_app_id}
GITHUB_PRIVATE_KEY_PATH=/etc/burstgrid/github-app.pem
ENVEOF
chmod 600 /etc/burstgrid/scheduler.env

systemctl daemon-reload
systemctl enable --now burstgrid-scheduler
