# Dify Fork on AWS ECS (CDK)

Infraestrutura CDK para rodar este fork do Dify em produção no AWS ECS (launch type EC2) com:

- ECS on EC2 (`web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`)
- Aurora PostgreSQL Serverless v2
- ElastiCache Valkey/Redis (TLS)
- S3 para arquivos e plugins
- ALB + Route53 + ACM (opcional)
- Secrets Manager + SSM Parameter

## Base arquitetural

Esta implementação foi desenhada a partir dos princípios do `aws-samples/dify-self-hosted-on-aws`:

- serviços de estado em managed services (Aurora, ElastiCache, S3)
- segregação de serviços `web` e `api`
- env/secrets via IAM + Secrets Manager/SSM
- ALB com roteamento por path para API e endpoints de extensão

A diferença principal é que esta implementação usa ECS on EC2 para reduzir custo recorrente.

Importante: por usar ECS on EC2 com `awsvpc`, habilite `awsvpcTrunking` na conta/região para aumentar a densidade de tasks por instância.

## Estrutura

- `bin/app.ts`: entrada da aplicação CDK
- `lib/config.ts`: schema de configuração
- `lib/dify-ecs-production-stack.ts`: stack principal (ECS + EC2 capacity provider)
- `config/production.example.json`: exemplo de configuração
- `scripts/push-fork-images.sh`: build/push das imagens do fork
- `scripts/enable-awsvpc-trunking.sh`: habilita awsvpc trunking para aumentar task density
- `docs/DEPLOY_ECS.md`: manual de deploy
- `docs/COST_COMPARISON_ECS_VS_EC2.md`: comparativo de custo
- `docs/TERRAFORM_MAPPING.md`: mapeamento de recursos para Terraform

## Começo rápido

```bash
cd infra/aws-cdk
npm ci
cp config/production.example.json config/production.json
# editar config/production.json

# subir imagens do fork
cd ../..
TAG=fork-2026-05-20 REGION=us-east-1 REPO=dify-images ./infra/aws-cdk/scripts/push-fork-images.sh

# habilitar trunking para task density em ECS on EC2
REGION=us-east-1 ./infra/aws-cdk/scripts/enable-awsvpc-trunking.sh

# deploy
cd infra/aws-cdk
export DIFY_CDK_CONFIG=./config/production.json
npx cdk bootstrap
npx cdk deploy
```

Consulte `docs/DEPLOY_ECS.md` para o passo a passo completo.
