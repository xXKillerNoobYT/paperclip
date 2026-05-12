#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-onboarding-vertical-slice.XXXXXX")"
METADATA_FILE="$TMP_DIR/smoke.env"
CONTAINER_NAME=""

PAPERCLIP_RELEASE_SMOKE_BASE_URL="${PAPERCLIP_RELEASE_SMOKE_BASE_URL:-http://127.0.0.1:3232}"
HOST_PORT="${HOST_PORT:-3232}"
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-$PAPERCLIP_RELEASE_SMOKE_BASE_URL}"
DATA_DIR="${DATA_DIR:-$TMP_DIR/data}"
IMAGE_NAME="${IMAGE_NAME:-paperclip-onboarding-vertical-slice}"
PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"
PRESERVE_SMOKE_CONTAINER="${PRESERVE_SMOKE_CONTAINER:-false}"

cleanup() {
  if [[ "$PRESERVE_SMOKE_CONTAINER" != "true" && -n "$CONTAINER_NAME" ]]; then
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ "$PRESERVE_SMOKE_CONTAINER" != "true" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "Preserved smoke metadata and data under: $TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

echo "==> Starting staging-like authenticated onboarding smoke instance"
SMOKE_DETACH=true \
SMOKE_METADATA_FILE="$METADATA_FILE" \
HOST_PORT="$HOST_PORT" \
PAPERCLIP_PUBLIC_URL="$PAPERCLIP_PUBLIC_URL" \
DATA_DIR="$DATA_DIR" \
IMAGE_NAME="$IMAGE_NAME" \
PAPERCLIP_DEPLOYMENT_MODE="$PAPERCLIP_DEPLOYMENT_MODE" \
PAPERCLIP_DEPLOYMENT_EXPOSURE="$PAPERCLIP_DEPLOYMENT_EXPOSURE" \
./scripts/docker-onboard-smoke.sh

# shellcheck source=/dev/null
source "$METADATA_FILE"
CONTAINER_NAME="${SMOKE_CONTAINER_NAME:-}"

if [[ -z "$CONTAINER_NAME" ]]; then
  echo "Smoke metadata did not include SMOKE_CONTAINER_NAME" >&2
  exit 1
fi

echo "==> Running onboarding release smoke against $SMOKE_BASE_URL"
PAPERCLIP_RELEASE_SMOKE_BASE_URL="$SMOKE_BASE_URL" \
PAPERCLIP_RELEASE_SMOKE_EMAIL="$SMOKE_ADMIN_EMAIL" \
PAPERCLIP_RELEASE_SMOKE_PASSWORD="$SMOKE_ADMIN_PASSWORD" \
pnpm test:release-smoke

echo "==> Onboarding vertical slice smoke passed"
