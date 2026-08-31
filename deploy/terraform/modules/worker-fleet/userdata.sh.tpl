#!/usr/bin/env bash
# BurstGrid worker agent — EC2 bootstrap (Ubuntu 24.04 ARM64)
set -euo pipefail
exec > >(tee /var/log/burstgrid-bootstrap.log) 2>&1

BUCKET="${s3_artifacts_bucket}"
RUNNER_VERSION="2.319.1"
FIRECRACKER_VERSION="${firecracker_version}"

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
  curl ca-certificates unzip git jq build-essential libssl-dev \
  iproute2 iptables

# ── Architecture detection ───────────────────────────────────────────────────
ARCH=$(uname -m)                          # aarch64 or x86_64
FC_ARCH=$([ "$ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64")
RUNNER_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64")
LABEL_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x86_64")
echo "[bootstrap] arch=$ARCH runner_arch=$RUNNER_ARCH"

# ── AWS CLI v2 (install early so S3 is available for all subsequent downloads) ─
if [[ "$ARCH" == "aarch64" ]]; then
  CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"
else
  CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
fi
curl -fsSL "$CLI_URL" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2
/tmp/awscliv2/aws/install
rm -rf /tmp/awscliv2 /tmp/awscliv2.zip
AWS=/usr/local/bin/aws

# ── Firecracker (S3 first — same-region, no rate limits; GitHub as fallback) ──
FC_S3="s3://$BUCKET/bin/firecracker-$FC_ARCH"
if $AWS s3 ls "$FC_S3" &>/dev/null; then
  $AWS s3 cp "$FC_S3" /usr/local/bin/firecracker --region "$REGION"
  chmod +x /usr/local/bin/firecracker
  echo "[bootstrap] firecracker installed from S3"
else
  echo "[bootstrap] firecracker not in S3, downloading from GitHub..."
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-$${FC_ARCH}.tgz" \
    | tar -xz -C /tmp
  install -m755 /tmp/release-$FIRECRACKER_VERSION-$${FC_ARCH}/firecracker-$FIRECRACKER_VERSION-$${FC_ARCH} /usr/local/bin/firecracker
  rm -rf /tmp/release-$FIRECRACKER_VERSION-$${FC_ARCH}
fi

# ── KVM device (built-in on Nitro kernels; udev may not create the node) ──────
[ -e /dev/kvm ] || mknod /dev/kvm c 10 232
chmod 660 /dev/kvm

# ── Host networking for microVMs ──────────────────────────────────────────────
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i tap+ -o eth0 -j ACCEPT
iptables -A FORWARD -o tap+ -i eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT

# ── Tag self with role (enables self-terminate IAM condition) ─────────────────
$AWS ec2 create-tags --region "$REGION" \
  --resources "$INSTANCE_ID" \
  --tags "Key=burstgrid:role,Value=runner" || true

# ── Node.js 24 ────────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# ── GitHub Actions runner (arch-aware) ───────────────────────────────────────
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -fsSLO \
  "https://github.com/actions/runner/releases/download/v$${RUNNER_VERSION}/actions-runner-linux-$${RUNNER_ARCH}-$${RUNNER_VERSION}.tar.gz"
tar xzf "actions-runner-linux-$${RUNNER_ARCH}-$${RUNNER_VERSION}.tar.gz"
./bin/installdependencies.sh

# Called by the worker-agent slot; RUNNER_LABELS from job assignment, arch appended dynamically
cat > /opt/actions-runner/burstgrid-run.sh << RUNSCRIPT
#!/usr/bin/env bash
set -euo pipefail
cd "\$${RUNNER_SLOT_DIR:-/opt/actions-runner}"
rm -f .runner .credentials .env
./config.sh \
  --url "\$RUNNER_REPO_URL" \
  --token "\$RUNNER_TOKEN" \
  --labels "\$RUNNER_LABELS,self-hosted,linux,$${LABEL_ARCH}" \
  --name "burstgrid-\$(hostname)-\$$" \
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
$AWS s3 cp "s3://$BUCKET/worker-agent.mjs" /opt/burstgrid/worker-agent.mjs

# ── VM kernel + rootfs ────────────────────────────────────────────────────────
mkdir -p /var/lib/burstgrid
$AWS s3 cp "s3://$BUCKET/vmlinux-$${FC_ARCH}" /var/lib/burstgrid/vmlinux 2>/dev/null || \
  $AWS s3 cp "s3://$BUCKET/vmlinux" /var/lib/burstgrid/vmlinux
if $AWS s3 ls "s3://$BUCKET/rootfs-$${LABEL_ARCH}.img.gz" &>/dev/null; then
  $AWS s3 cp "s3://$BUCKET/rootfs-$${LABEL_ARCH}.img.gz" /tmp/rootfs.img.gz
  gunzip -c /tmp/rootfs.img.gz > /var/lib/burstgrid/rootfs.img
  rm /tmp/rootfs.img.gz
elif $AWS s3 ls "s3://$BUCKET/rootfs.img.gz" &>/dev/null; then
  $AWS s3 cp "s3://$BUCKET/rootfs.img.gz" /tmp/rootfs.img.gz
  gunzip -c /tmp/rootfs.img.gz > /var/lib/burstgrid/rootfs.img
  rm /tmp/rootfs.img.gz
else
  $AWS s3 cp "s3://$BUCKET/rootfs-$${LABEL_ARCH}.img" /var/lib/burstgrid/rootfs.img 2>/dev/null || \
    $AWS s3 cp "s3://$BUCKET/rootfs.img" /var/lib/burstgrid/rootfs.img
fi

# ── Per-image rootfs catalog (optional; skipped if image not yet in S3) ───────
IMAGE_DIR=/var/lib/burstgrid/images
mkdir -p "$IMAGE_DIR"
for IMG_NAME in ubuntu-docker; do
  S3_KEY="rootfs-$${LABEL_ARCH}-$${IMG_NAME}.img.gz"
  if $AWS s3 ls "s3://$BUCKET/$${S3_KEY}" &>/dev/null; then
    $AWS s3 cp "s3://$BUCKET/$${S3_KEY}" /tmp/img.gz
    gunzip -c /tmp/img.gz > "$IMAGE_DIR/$${IMG_NAME}.img"
    rm /tmp/img.gz
    echo "[bootstrap] downloaded image: $${IMG_NAME}"
  fi
done

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
Environment=BURSTGRID_MODE=firecracker
Environment=BURSTGRID_VM_IMAGE=/var/lib/burstgrid/rootfs.img
Environment=BURSTGRID_KERNEL=/var/lib/burstgrid/vmlinux
Environment=BURSTGRID_IMAGE_DIR=/var/lib/burstgrid/images
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
