#!/usr/bin/env bash
# Build a Firecracker rootfs (.img) from a Dockerfile.
#
# Usage:
#   ./scripts/build-rootfs.sh <Dockerfile> <output.img> [size]
#
# Examples:
#   ./scripts/build-rootfs.sh rootfs/ubuntu-docker/Dockerfile /opt/images/ubuntu-docker.img 4G
#   ./scripts/build-rootfs.sh rootfs/node20/Dockerfile /opt/images/node20.img 2G
#
# The resulting .img is an ext4 filesystem you can reference in burstgrid.config.yaml:
#
#   worker:
#     images:
#       - name: ubuntu-docker
#         path: /opt/images/ubuntu-docker.img
#         description: "Ubuntu 22.04 + Docker 24"
#         os: ubuntu-22.04
#         tools: [docker, git, curl]
#         docker_version: "24.0"
#
# Requirements: docker, mkfs.ext4 (e2fsprogs), dd, sudo

set -euo pipefail

DOCKERFILE="${1:?Usage: $0 <Dockerfile> <output.img> [size]}"
OUTPUT="${2:?Usage: $0 <Dockerfile> <output.img> [size]}"
IMG_SIZE="${3:-2G}"

TAG="burstgrid-rootfs-builder-$$"
CONTEXT_DIR="$(dirname "$DOCKERFILE")"
WORK_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$TAG" 2>/dev/null || true
  sudo rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "[build-rootfs] building Docker image from $DOCKERFILE..."
docker build -t "$TAG" -f "$DOCKERFILE" "$CONTEXT_DIR"

echo "[build-rootfs] exporting filesystem to $WORK_DIR/rootfs..."
mkdir -p "$WORK_DIR/rootfs"
docker create --name "$TAG" "$TAG"
docker export "$TAG" | tar -C "$WORK_DIR/rootfs" -xf -

# The init script must be at /sbin/init in the rootfs.
# Copy the BurstGrid VM init script if not already present in the image.
if [[ ! -f "$WORK_DIR/rootfs/sbin/burstgrid-init" ]]; then
  echo "[build-rootfs] installing burstgrid-init into rootfs..."
  install -Dm755 "$(dirname "$0")/vm-init.sh" "$WORK_DIR/rootfs/sbin/burstgrid-init"
fi

echo "[build-rootfs] creating ${IMG_SIZE} ext4 image at $OUTPUT..."
mkdir -p "$(dirname "$OUTPUT")"
dd if=/dev/zero of="$OUTPUT" bs=1 count=0 seek="$IMG_SIZE" 2>/dev/null
mkfs.ext4 -F -d "$WORK_DIR/rootfs" "$OUTPUT"

echo "[build-rootfs] done → $OUTPUT"
echo "[build-rootfs] size: $(du -sh "$OUTPUT" | cut -f1)"
