#!/bin/bash
# Build the BioClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="bioclaw-agent"
TAG="${1:-latest}"
USER_BASE_IMAGE="${2:-${BASE_IMAGE:-}}"

echo "Building BioClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found. Please install Docker Desktop first."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running. Start Docker Desktop and retry."
  exit 1
fi

if [[ -n "${USER_BASE_IMAGE}" ]]; then
  BASE_IMAGES=("${USER_BASE_IMAGE}")
else
  BASE_IMAGES=(
    "node:22-slim"
    "mirror.gcr.io/library/node:22-slim"
    "docker.m.daocloud.io/library/node:22-slim"
  )
fi

BUILT=0
USED_BASE_IMAGE=""

for BASE in "${BASE_IMAGES[@]}"; do
  echo ""
  echo "Trying base image: ${BASE}"
  if docker build --pull=true --build-arg "BASE_IMAGE=${BASE}" -t "${IMAGE_NAME}:${TAG}" .; then
    BUILT=1
    USED_BASE_IMAGE="${BASE}"
    break
  fi
  echo "Build failed with base image: ${BASE}"
done

if [[ "${BUILT}" -ne 1 ]]; then
  echo ""
  echo "Build failed for all base image sources."
  echo "You can try:"
  echo "  1) Configure Docker Desktop registry mirrors"
  echo "  2) Run with explicit base image:"
  echo "     BASE_IMAGE=docker.m.daocloud.io/library/node:22-slim ./container/build.sh ${TAG}"
  exit 1
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Base image: ${USED_BASE_IMAGE}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
