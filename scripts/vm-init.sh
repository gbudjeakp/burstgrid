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
RUNNER_REPO_URL="$(extract RUNNER_REPO_URL)"
REGISTRY_MIRROR="$(extract REGISTRY_MIRROR)"
GUEST_IP="$(extract GUEST_IP)"
GATEWAY="$(extract GATEWAY)"

if [ -z "$RUNNER_TOKEN" ]; then
  echo "[init] ERROR: RUNNER_TOKEN not found in /proc/cmdline" >&2
  halt -f
fi

if [ -z "$RUNNER_REPO_URL" ]; then
  echo "[init] ERROR: RUNNER_REPO_URL not found in /proc/cmdline" >&2
  halt -f
fi

# ── Network ───────────────────────────────────────────────────────────────────
if [ -n "$GUEST_IP" ] && [ -n "$GATEWAY" ]; then
  ip addr add "${GUEST_IP}/30" dev eth0 2>/dev/null || true
  ip link set eth0 up
  ip route add default via "$GATEWAY"
  printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf
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

# Ensure all standard bin dirs are in PATH so runner worker processes find sh, env, etc.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Allow the runner to execute as root (PID 1 in a microVM is always root).
export RUNNER_ALLOW_RUNASROOT=1

# The .NET runner binary needs HOME to locate user-profile directories.
export HOME=/root
mkdir -p /root

# Derive a unique runner name from the guest IP (guaranteed unique per-slot).
# Falls back to a random hex string if GUEST_IP is not set.
_ip_tag="$(echo "${GUEST_IP:-}" | tr '.' '-')"
RUNNER_NAME="burstgrid-${_ip_tag:-$(dd if=/dev/urandom bs=4 count=1 2>/dev/null | od -A n -t x4 | tr -d ' \n')}"

# Register as an ephemeral runner — removed automatically after one job.
# config.sh may exit non-zero even when configuration succeeds (Runner.Listener
# throws a null-ref in post-config cleanup on some ARM64 environments).
# We tolerate that by checking for the .runner sentinel file instead.
./config.sh \
  --unattended \
  --ephemeral \
  --replace \
  --url "$RUNNER_REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --labels "$RUNNER_LABELS" \
  --name "$RUNNER_NAME" \
  --work _work || true

if [ ! -f ".runner" ]; then
  echo "[init] ERROR: runner configuration failed (no .runner file)" >&2
  halt -f
fi

./run.sh

# ── Tear down and halt ────────────────────────────────────────────────────────
if [ -n "${DOCKER_PID:-}" ]; then
  kill "$DOCKER_PID" 2>/dev/null || true
fi

halt -f
