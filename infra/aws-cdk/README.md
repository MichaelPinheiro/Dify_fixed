# Dify Fork on AWS ECS (CDK)

Infraestrutura CDK para rodar este fork do Dify em produção no AWS ECS/Fargate com:

- ECS/Fargate (`web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`)
- Aurora PostgreSQL Serverless v2
- ElastiCache Valkey/Redis (TLS)
- S3 para arquivos e plugins
- ALB + Route53 + ACM (opcional)
- Secrets Manager + SSM Parameter

## Estrutura

- `bin/app.ts`: entrada da aplicação CDK
- `lib/config.ts`: schema de configuração
- `lib/dify-ecs-production-stack.ts`: stack principal
- `config/production.example.json`: exemplo de configuração
- `scripts/push-fork-images.sh`: build/push das imagens do fork
- `docs/DEPLOY_ECS.md`: manual de deploy
- `docs/COST_COMPARISON_ECS_VS_EC2.md`: comparativo de custo

## Começo rápido

```bash
cd infra/aws-cdk
npm ci
cp config/production.example.json config/production.json
# editar config/production.json

# subir imagens do fork
cd ../..
TAG=fork-2026-05-20 REGION=us-east-1 REPO=dify-images ./infra/aws-cdk/scripts/push-fork-images.sh

# deploy
cd infra/aws-cdk
export DIFY_CDK_CONFIG=./config/production.json
npx cdk bootstrap
npx cdk deploy
```

Consulte `docs/DEPLOY_ECS.md` para o passo a passo completo.
