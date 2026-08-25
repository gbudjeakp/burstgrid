#!/bin/bash
set -euo pipefail

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

# Download and install BurstGrid worker agent
curl -fsSL https://github.com/burstgrid/burstgrid/releases/latest/download/worker-agent.tar.gz \
  | tar -C /usr/local/bin -xz worker-agent

# Resolve instance-id via IMDSv2
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/instance-id")
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/placement/availability-zone")

cat > /etc/systemd/system/burstgrid-worker.service << EOF
[Unit]
Description=BurstGrid Worker Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=BURSTGRID_SCHEDULER_URL=${scheduler_endpoint}
Environment=BURSTGRID_WORKER_ID=$INSTANCE_ID
Environment=BURSTGRID_SLOTS=${slots_per_worker}
Environment=BURSTGRID_VM_IMAGE=/var/lib/burstgrid/runner.img
Environment=BURSTGRID_KERNEL=/var/lib/burstgrid/vmlinux
Environment=AWS_AZ=$AZ
ExecStart=/usr/local/bin/worker-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now burstgrid-worker
