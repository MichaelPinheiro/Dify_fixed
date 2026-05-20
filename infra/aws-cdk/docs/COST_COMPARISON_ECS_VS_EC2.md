# Comparativo de Custos: ECS vs EC2 (5-8 usuários simultâneos)

Data de referência: **20/05/2026**
Região de referência: **us-east-1**

> Valores abaixo são estimativas para tomada de decisão inicial. Sempre validar no AWS Pricing Calculator antes de aprovar custo final.

## Cenário de carga considerado

- 5 a 8 usuários simultâneos
- Uso misto: chat, workflows, uploads moderados
- Serviços do fork: `web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`

## Opção A: ECS/Fargate + serviços gerenciados (recomendado)

Componentes:

- Fargate para serviços da aplicação
- Aurora Serverless v2
- ElastiCache Valkey
- ALB
- S3
- Secrets Manager
- NAT (se necessário)

Faixa mensal típica:

- **US$ 120 ~ US$ 260 / mês** (infra)

## Opção B: EC2 all-in-one (tudo na VM)

Componentes:

- 1x EC2 (`t3.xlarge` recomendado para produção mínima)
- EBS
- ALB opcional

Faixa mensal típica:

- **US$ 70 ~ US$ 160 / mês** (infra)

Risco operacional:

- ponto único de falha
- scaling manual
- manutenção de SO, Docker, backup e restore por conta do time

## Opção C: EC2 para app + RDS/Redis gerenciados

Componentes:

- 1x EC2 (`t3.large`/`t3.xlarge`) para app containers
- Aurora + ElastiCache + S3 + ALB

Faixa mensal típica:

- **US$ 140 ~ US$ 300 / mês** (infra)

## Leitura prática

- **Menor custo bruto**: EC2 all-in-one
- **Melhor equilíbrio produção**: ECS/Fargate + managed data services
- **Melhor resiliência e escalabilidade**: ECS/Fargate

## Custos fora da infra

- Custo de LLM (OpenAI, Bedrock, etc.)
- Transferência de dados para Internet
- Armazenamento de arquivos e logs

Em muitos casos, o custo de modelo supera o custo de infraestrutura.

## Recomendação para este fork

Para seu cenário (5-8 simultâneos + necessidade de estabilidade):

1. Começar em **ECS/Fargate** com sizing enxuto.
2. Monitorar 2-4 semanas (CPU/Memória, latência, fila do Celery).
3. Ajustar `api` e `worker` com autoscaling até `max=2`.

Se a prioridade número 1 for apenas custo de curto prazo e vocês aceitarem risco operacional, EC2 é viável para PoC, mas não é a melhor base para produção contínua.
