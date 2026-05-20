# Manual: Deploy do Fork no ECS com CDK

Este manual foi feito para este fork do Dify e já considera produção com serviços separados (`web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`).

## 1) Pré-requisitos

- AWS CLI configurado com permissões para CDK/ECS/RDS/ElastiCache/Route53/ACM/S3/Secrets
- Node.js 20+
- Docker + buildx
- Conta AWS com cota para Fargate, ALB, RDS e ElastiCache

## 2) Preparar configuração

```bash
cd infra/aws-cdk
cp config/production.example.json config/production.json
```

Edite `config/production.json` com:

- `environment.account` e `environment.region`
- `domain` (se tiver domínio público no Route53)
- `images.api` e `images.web` para as imagens do seu fork no ECR
- sizing dos serviços conforme carga inicial

## 3) Build e push das imagens do fork

Na raiz do projeto:

```bash
TAG=fork-2026-05-20 REGION=us-east-1 REPO=dify-images ./infra/aws-cdk/scripts/push-fork-images.sh
```

Depois atualize no `config/production.json`:

- `images.api = <ECR>/dify-images:dify-api_<TAG>`
- `images.web = <ECR>/dify-images:dify-web_<TAG>`

## 4) Deploy CDK

```bash
cd infra/aws-cdk
npm ci
export DIFY_CDK_CONFIG=./config/production.json
npx cdk bootstrap
npx cdk deploy
```

## 5) O que a stack sobe

- VPC com subnets públicas e privadas
- ALB com roteamento:
  - `/api`, `/v1`, `/console/api`, `/files`, `/triggers` -> `api`
  - `/e` -> `plugin_daemon`
  - `/*` -> `web`
- ECS Fargate services:
  - `web`
  - `api`
  - `worker`
  - `worker_beat`
  - `sandbox`
  - `plugin_daemon`
  - `ssrf_proxy`
- Aurora PostgreSQL Serverless v2 + criação de database `pgvector`
- ElastiCache Valkey/Redis com TLS
- Bucket S3 para storage do Dify e plugins
- Secrets Manager / SSM para segredos e broker URL

## 6) Variáveis de produção já tratadas

A stack já define automaticamente os principais envs de produção, incluindo:

- `STORAGE_TYPE=s3`
- `S3_USE_AWS_MANAGED_IAM=true`
- `VECTOR_STORE=pgvector`
- `REDIS_USE_SSL=true`
- `CELERY_BROKER_URL=rediss://...`
- `PLUGIN_STORAGE_TYPE=aws_s3`
- `MODE` correto para `api`, `worker` e `worker_beat`

Se precisar complementar, use `app.additionalEnvironmentVariables` no JSON de config.

## 7) Sizing inicial recomendado (5-8 simultâneos)

- `web`: 0.5 vCPU / 1 GiB, min 1 max 2
- `api`: 1 vCPU / 2 GiB, min 1 max 2
- `worker`: 1 vCPU / 2 GiB, min 1 max 2
- `worker_beat`: 0.25 vCPU / 0.5 GiB, fixo 1
- `sandbox`: 0.5 vCPU / 1 GiB, fixo 1
- `plugin_daemon`: 0.5 vCPU / 1 GiB, fixo 1
- `ssrf_proxy`: 0.25 vCPU / 0.5 GiB, fixo 1

## 8) Operação diária

- Logs: CloudWatch Logs por serviço
- Shell em task: `aws ecs execute-command`
- Escala: alterar `config/production.json` e redeploy CDK
- Upgrade de imagem:
  1. push nova tag no ECR
  2. atualizar `images.api`/`images.web`
  3. `cdk deploy`

## 9) Rollback

- Volte as tags anteriores no `config/production.json`
- `cdk deploy` novamente

## 10) Observações importantes

- `worker_beat` foi mantido separado para aderência ao seu fork.
- Para reduzir custo inicial, você pode usar `capacityProvider = FARGATE_SPOT` apenas em ambiente não crítico.
- Em produção crítica, prefira `FARGATE` normal para `api/web`.
