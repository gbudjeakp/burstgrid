#!/usr/bin/env bash
# Build a Firecracker rootfs (.img or .img.gz) from a Dockerfile.
#
# Usage:
#   ./scripts/build-rootfs.sh <Dockerfile> <output.img> [size] [arch] [--compress]
#
# Examples:
#   ./scripts/build-rootfs.sh rootfs/template/Dockerfile /opt/images/my-image-arm64.img 4G arm64 --compress
#   ./scripts/build-rootfs.sh rootfs/template/Dockerfile /opt/images/my-image-x86_64.img 4G amd64 --compress
#
# Always use --compress: ext4 images are mostly empty space; gzip reduces a 4G image to ~400-600 MB.
#
# Requirements: docker, mkfs.ext4 (e2fsprogs), dd, sudo

set -euo pipefail

DOCKERFILE="${1:?Usage: $0 <Dockerfile> <output.img> [size] [arch] [--compress]}"
OUTPUT="${2:?Usage: $0 <Dockerfile> <output.img> [size] [arch] [--compress]}"
IMG_SIZE="${3:-4G}"   # ext4 partition size; 4G needed for Node.js tool cache
ARCH="${4:-arm64}"
COMPRESS="${5:-}"

DOCKER_PLATFORM="linux/${ARCH}"
TAG="burstgrid-rootfs-builder-$$"
CONTEXT_DIR="$(dirname "$DOCKERFILE")"
WORK_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$TAG" 2>/dev/null || true
  sudo rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "[build-rootfs] arch=${ARCH} size=${IMG_SIZE} dockerfile=$DOCKERFILE"
echo "[build-rootfs] building Docker image for ${DOCKER_PLATFORM}..."
docker buildx build --platform "$DOCKER_PLATFORM" \
  --build-arg "TARGETARCH=${ARCH}" \
  -t "$TAG" -f "$DOCKERFILE" "$CONTEXT_DIR" --load

echo "[build-rootfs] exporting filesystem to $WORK_DIR/rootfs..."
mkdir -p "$WORK_DIR/rootfs"
docker create --name "$TAG" --platform "$DOCKER_PLATFORM" "$TAG"
docker export "$TAG" | tar -C "$WORK_DIR/rootfs" -xf -

# Copy the BurstGrid VM init script if not already present in the image.
if [[ ! -f "$WORK_DIR/rootfs/sbin/burstgrid-init" ]]; then
  echo "[build-rootfs] installing burstgrid-init into rootfs..."
  install -Dm755 "$(dirname "$0")/vm-init.sh" "$WORK_DIR/rootfs/sbin/burstgrid-init"
fi

echo "[build-rootfs] creating ${IMG_SIZE} ext4 image at $OUTPUT..."
mkdir -p "$(dirname "$OUTPUT")"
dd if=/dev/zero of="$OUTPUT" bs=1 count=0 seek="$IMG_SIZE" 2>/dev/null
mkfs.ext4 -F -d "$WORK_DIR/rootfs" "$OUTPUT"

if [[ "$COMPRESS" == "--compress" ]]; then
  echo "[build-rootfs] compressing → ${OUTPUT}.gz ..."
  gzip -9 -k "$OUTPUT"
  echo "[build-rootfs] compressed: $(du -sh "${OUTPUT}.gz" | cut -f1)"
fi

echo "[build-rootfs] done → $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"
