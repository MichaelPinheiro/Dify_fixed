#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   TAG=fork-2026-05-20 REGION=us-east-1 REPO=dify-images ./scripts/push-fork-images.sh

TAG="${TAG:-fork-$(date +%Y%m%d-%H%M)}"
REGION="${REGION:-us-east-1}"
REPO="${REPO:-dify-images}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ECR="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "[1/5] Ensuring ECR repository exists"
aws ecr create-repository --repository-name "${REPO}" --region "${REGION}" >/dev/null 2>&1 || true

echo "[2/5] Logging into ECR"
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${ECR}"

echo "[3/5] Building and pushing API image"
docker buildx build \
  --platform linux/amd64 \
  -f api/Dockerfile \
  -t "${ECR}/${REPO}:dify-api_${TAG}" \
  --push \
  api

echo "[4/5] Building and pushing WEB image"
docker buildx build \
  --platform linux/amd64 \
  -f web/Dockerfile \
  -t "${ECR}/${REPO}:dify-web_${TAG}" \
  --push \
  .

echo "[5/5] Done"
echo "API image: ${ECR}/${REPO}:dify-api_${TAG}"
echo "WEB image: ${ECR}/${REPO}:dify-web_${TAG}"
