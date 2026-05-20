# Manual: Deploy do Fork no ECS (EC2) com CDK

Este manual foi feito para este fork do Dify e já considera produção com serviços separados (`web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`) em **ECS launch type EC2** (sem Fargate).

## 1) Pré-requisitos

- AWS CLI configurado com permissões para CDK/ECS/RDS/ElastiCache/Route53/ACM/S3/Secrets
- Node.js 20+
- Docker + buildx
- Conta AWS com cota para ECS/EC2, ALB, RDS e ElastiCache

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

## 4.1) Importante: limite de tasks por ENI (ECS on EC2 + `awsvpc`)

Como esta stack usa `networkMode=awsvpc`, cada task consome ENI. Sem trunking, instâncias pequenas podem não comportar todos os serviços.

Exemplo (AWS docs):

- `m6i.large`: limite de **2 tasks** sem trunking, **10 tasks** com trunking habilitado

Para evitar tasks em `PENDING`, habilite antes:

Na raiz do projeto:

```bash
REGION=us-east-1 ./infra/aws-cdk/scripts/enable-awsvpc-trunking.sh
```

Depois disso, faça recycle das instâncias do cluster (novas instâncias passam a usar o limite aumentado).

## 5) O que a stack sobe

- VPC com subnets públicas e privadas
- ALB com roteamento:
  - `/api`, `/v1`, `/console/api`, `/files`, `/triggers` -> `api`
  - `/e` -> `plugin_daemon`
  - `/*` -> `web`
- ECS services (EC2 launch type):
  - `web`
  - `api`
  - `worker`
  - `worker_beat`
  - `sandbox`
  - `plugin_daemon`
  - `ssrf_proxy`
- Auto Scaling Group de EC2 com ECS Optimized AMI + ECS Capacity Provider
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

- Cluster EC2: `m6i.large`, `min=2`, `desired=2`, `max=4`
- Tasks:
  - `web`: cpu 256 / 1 GiB, min 1 max 2
  - `api`: cpu 512 / 2 GiB, min 1 max 2
  - `worker`: cpu 512 / 2 GiB, min 1 max 2
  - `worker_beat`: cpu 256 / 0.5 GiB, fixo 1
  - `sandbox`: cpu 256 / 1 GiB, fixo 1
  - `plugin_daemon`: cpu 256 / 1 GiB, fixo 1
  - `ssrf_proxy`: cpu 256 / 0.5 GiB, fixo 1

Observação:

- esse sizing assume `awsvpcTrunking` habilitado
- sem trunking, aumente instâncias do cluster para evitar saturação de ENI

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
- Para reduzir custo de EC2, você pode habilitar `ecsEc2.useSpotInstances=true` no `production.json`.
- Em produção crítica, mantenha `useSpotInstances=false` para evitar interrupções de tasks.
