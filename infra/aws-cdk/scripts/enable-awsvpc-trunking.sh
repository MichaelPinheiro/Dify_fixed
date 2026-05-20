#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   REGION=us-east-1 ./scripts/enable-awsvpc-trunking.sh

REGION="${REGION:-us-east-1}"

echo "[1/2] Enabling ECS awsvpcTrunking default in ${REGION}"
aws ecs put-account-setting-default \
  --name awsvpcTrunking \
  --value enabled \
  --region "${REGION}" >/dev/null

echo "[2/2] Current account setting"
aws ecs list-account-settings \
  --name awsvpcTrunking \
  --effective-settings \
  --region "${REGION}" \
  --query "settings[0].[name,value,principalArn]" \
  --output table
