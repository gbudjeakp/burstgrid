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

# Secrets are deliberately fetched after the instance receives its IAM role.
# SSM mode keeps values out of launch-template/user-data history and Terraform
# state. The terraform mode below exists only for short-lived compatibility.
secret() {
  /usr/local/bin/aws ssm get-parameter --name "$1" --with-decryption \
    --region "${aws_region}" --query Parameter.Value --output text
}
%{ if secret_source == "ssm" ~}
WEBHOOK_SECRET=$(secret '${webhook_secret_ssm_parameter}')
WORKER_TOKEN=$(secret '${worker_token_ssm_parameter}')
GITHUB_TOKEN_VALUE=$(secret '${github_token_ssm_parameter}' 2>/dev/null || true)
GITHUB_APP_PRIVATE_KEY=$(secret '${github_app_key_ssm_parameter}' 2>/dev/null || true)
# EnvironmentFile is line-oriented; preserve PEM newlines as literal backslash-n
# sequences, which bin/scheduler.ts expands before handing the key to Octokit.
GITHUB_APP_PRIVATE_KEY=$${GITHUB_APP_PRIVATE_KEY//$'\n'/\\n}
%{ else ~}
WEBHOOK_SECRET='${webhook_secret}'
WORKER_TOKEN='${worker_token}'
GITHUB_TOKEN_VALUE='${github_token}'
GITHUB_APP_PRIVATE_KEY=''
%{ endif ~}

# ── Node.js 20 (NodeSource) ───────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── Download artifacts from S3 ────────────────────────────────────────────────
mkdir -p "$WORKDIR"
/usr/local/bin/aws s3 cp "s3://$BUCKET/scheduler.mjs" "$WORKDIR/scheduler.mjs"

%{ if otel_collector_enabled ~}
# The SecureString is an EnvironmentFile payload containing the exporter values
# required by deploy/otel-collector/collector.yaml.
OTEL_ARCH=$([ "$ARCH" = "aarch64" ] && echo arm64 || echo amd64)
curl -fsSL "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${otel_collector_version}/otelcol-contrib_${otel_collector_version}_linux_$${OTEL_ARCH}.tar.gz" | tar -xz -C /usr/local/bin otelcol-contrib
install -d -m 0755 /etc/burstgrid /etc/otelcol-contrib
/usr/local/bin/aws s3 cp "s3://$BUCKET/otel-collector.yaml" /etc/otelcol-contrib/collector.yaml
secret '${otel_env_ssm_parameter}' > /etc/burstgrid/otelcol.env
chmod 600 /etc/burstgrid/otelcol.env
cat > /etc/systemd/system/burstgrid-otelcol.service << 'OTELUNIT'
[Unit]
Description=BurstGrid OpenTelemetry Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/burstgrid/otelcol.env
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol-contrib/collector.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
OTELUNIT
%{ endif ~}

# ── Environment file ──────────────────────────────────────────────────────────
cat > "$WORKDIR/.env" << 'ENVEOF'
BURSTGRID_PORT=8080
BURSTGRID_ADDR=0.0.0.0
AWS_REGION=${aws_region}
BURSTGRID_WEBHOOK_SECRET=$WEBHOOK_SECRET
BURSTGRID_WORKER_TOKEN=$WORKER_TOKEN
BURSTGRID_SPOT_QUEUE_URL=${spot_queue_url}
BURSTGRID_FLEETS=${burstgrid_fleets}
GITHUB_TOKEN=$GITHUB_TOKEN_VALUE
GITHUB_APP_ID=${github_app_id}
GITHUB_PRIVATE_KEY=$GITHUB_APP_PRIVATE_KEY
%{ if otel_collector_enabled ~}
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
%{ endif ~}
ENVEOF
chmod 600 "$WORKDIR/.env"

# ── Systemd service ───────────────────────────────────────────────────────────
cat > /etc/systemd/system/burstgrid-scheduler.service << 'SVCEOF'
[Unit]
Description=BurstGrid Scheduler
After=network-online.target
Wants=network-online.target
%{ if otel_collector_enabled ~}
After=burstgrid-otelcol.service
Wants=burstgrid-otelcol.service
%{ endif ~}

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
%{ if otel_collector_enabled ~}
systemctl enable --now burstgrid-otelcol
%{ endif ~}
systemctl enable --now burstgrid-scheduler
echo "[bootstrap] scheduler started"
