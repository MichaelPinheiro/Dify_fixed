#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_PATH="${1:-${DIFY_CDK_CONFIG:-./config/production.json}}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

cd "${CDK_DIR}"

echo "[1/7] Preflight checks"
require_cmd aws
require_cmd node
require_cmd npm
require_cmd npx
aws sts get-caller-identity >/dev/null

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "config file not found: ${CONFIG_PATH}" >&2
  exit 1
fi

echo "[2/7] Install dependencies"
if [[ ! -f package-lock.json ]]; then
  npm install --package-lock-only
fi
npm ci

echo "[3/7] Validate configuration"
npm run validate-config -- "${CONFIG_PATH}"

echo "[4/7] Build TypeScript"
npm run build

export DIFY_CDK_CONFIG="${CONFIG_PATH}"

echo "[5/7] CDK synth"
npx cdk synth >/dev/null

echo "[6/7] CDK diff"
npx cdk diff

echo "[7/7] Confirmation"
read -r -p "Deploy stack now using ${CONFIG_PATH}? (yes/no): " confirm
if [[ "${confirm}" != "yes" ]]; then
  echo "deploy cancelled"
  exit 0
fi

npx cdk deploy
