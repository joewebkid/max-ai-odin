#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/codex-lb"
DATA_DIR="$APP_DIR/data"
ENV_FILE="$APP_DIR/.env"
CONTAINER_NAME="codex-lb-container"
IMAGE="codex-lb-local:1.15.0"

mkdir -p "$DATA_DIR"

cleanup() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  --add-host=host.docker.internal:host-gateway \
  -p 2455:2455 \
  -p 1455:1455 \
  -v "$DATA_DIR:/var/lib/codex-lb" \
  "$IMAGE"
