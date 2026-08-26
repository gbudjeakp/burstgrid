#!/bin/sh
# BurstGrid VM init — runs as PID 1 inside the Firecracker microVM.
#
# Reads RUNNER_TOKEN, RUNNER_LABELS, and optional REGISTRY_MIRROR from
# /proc/cmdline (set by the worker agent via the Firecracker boot-source API),
# configures the GitHub Actions runner, runs the job, then halts the VM.
#
# This script is installed at /sbin/burstgrid-init in every rootfs image.
# The Firecracker kernel boot arg should be: init=/sbin/burstgrid-init
#
# Expected /proc/cmdline format (injected by worker agent):
#   console=ttyS0 reboot=k panic=1 pci=off RUNNER_TOKEN=<jwt> RUNNER_LABELS=<csv> [REGISTRY_MIRROR=<url>]

set -e

# ── Mount essential pseudo-filesystems ───────────────────────────────────────
mount -t proc  proc  /proc  2>/dev/null || true
mount -t sysfs sysfs /sys   2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts 2>/dev/null || true

# ── Parse kernel cmdline ──────────────────────────────────────────────────────
cmdline="$(cat /proc/cmdline)"

extract() {
  echo "$cmdline" | tr ' ' '\n' | grep "^$1=" | cut -d= -f2- | head -1
}

RUNNER_TOKEN="$(extract RUNNER_TOKEN)"
RUNNER_LABELS="$(extract RUNNER_LABELS)"
REGISTRY_MIRROR="$(extract REGISTRY_MIRROR)"

if [ -z "$RUNNER_TOKEN" ]; then
  echo "[init] ERROR: RUNNER_TOKEN not found in /proc/cmdline" >&2
  halt -f
fi

# ── Optional: configure Docker registry mirror ────────────────────────────────
if [ -n "$REGISTRY_MIRROR" ] && command -v dockerd >/dev/null 2>&1; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<EOF
{"registry-mirrors": ["$REGISTRY_MIRROR"]}
EOF
fi

# ── Start Docker daemon if present ───────────────────────────────────────────
if command -v dockerd >/dev/null 2>&1; then
  dockerd --host=unix:///var/run/docker.sock \
          --storage-driver=overlay2 \
          --log-level=warn &
  DOCKER_PID=$!
  # Wait for Docker socket to be ready (up to 15s)
  i=0
  while [ ! -S /var/run/docker.sock ] && [ $i -lt 30 ]; do
    sleep 0.5; i=$((i+1))
  done
fi

# ── Configure and run the GitHub Actions runner ───────────────────────────────
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"

if [ ! -f "$RUNNER_DIR/config.sh" ]; then
  echo "[init] ERROR: runner not found at $RUNNER_DIR" >&2
  halt -f
fi

cd "$RUNNER_DIR"

# Register as an ephemeral runner — removed automatically after one job.
./config.sh \
  --unattended \
  --ephemeral \
  --url "https://github.com" \
  --token "$RUNNER_TOKEN" \
  --labels "$RUNNER_LABELS" \
  --name "burstgrid-$(hostname)" \
  --work _work

./run.sh

# ── Tear down and halt ────────────────────────────────────────────────────────
if [ -n "${DOCKER_PID:-}" ]; then
  kill "$DOCKER_PID" 2>/dev/null || true
fi

halt -f
