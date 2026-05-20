# Comparativo de Custos: ECS on EC2 vs EC2 all-in-one

Data de referência: **20/05/2026**
Região de referência: **us-east-1**

> Este comparativo já desconsidera Fargate, conforme decisão do time.

## Cenário de carga considerado

- 5 a 8 usuários simultâneos
- Uso misto: chat, workflows, uploads moderados
- Serviços do fork: `web`, `api`, `worker`, `worker_beat`, `sandbox`, `plugin_daemon`, `ssrf_proxy`

## Opção A: ECS on EC2 (arquitetura recomendada nesta branch)

Componentes:

- ECS Cluster com Capacity Provider em Auto Scaling Group (EC2)
- Aurora Serverless v2
- ElastiCache Valkey
- ALB
- S3
- Secrets Manager

Faixa mensal típica (infra):

- **US$ 95 ~ US$ 220 / mês**

Observação de dimensionamento:

- com `awsvpcTrunking` habilitado, o custo fica nessa faixa (menos instâncias para a mesma quantidade de tasks)
- sem `awsvpcTrunking`, pode precisar de mais instâncias EC2 e aumentar o custo mensal

Vantagens:

- custo menor que Fargate para carga contínua
- separação de serviços e scaling por task
- rollback/deploy mais limpo que docker-compose direto em VM

Trade-offs:

- precisa gerenciar capacidade EC2 do cluster
- patching/observabilidade da camada EC2

## Opção B: EC2 all-in-one (docker-compose na VM)

Componentes:

- 1x EC2 (`t3.xlarge` recomendado para 5-8 simultâneos)
- EBS
- ALB opcional

Faixa mensal típica (infra):

- **US$ 70 ~ US$ 160 / mês**

Vantagens:

- menor custo bruto inicial
- simples para PoC

Trade-offs:

- ponto único de falha
- scaling manual
- backup/restore/patching por conta do time
- maior risco operacional em produção

## Leitura prática

- **Menor custo puro**: EC2 all-in-one
- **Melhor equilíbrio custo x operação**: ECS on EC2
- **Melhor caminho para evoluir sem reescrever tudo**: ECS on EC2 com ASG + serviços gerenciados

## Custos fora da infra

- consumo de LLM (OpenAI, Bedrock, etc.)
- transferência de dados
- armazenamento de logs e objetos

Em cenários com uso intenso de IA, o custo do modelo pode ultrapassar o custo da infra.

## Observação sobre Terraform

Se o time usa Terraform no dia a dia, mantenha a **mesma arquitetura lógica** desta branch:

- VPC + ALB + ECS Cluster (EC2 capacity provider)
- Services: `web/api/worker/worker_beat/sandbox/plugin_daemon/ssrf_proxy`
- Aurora + ElastiCache + S3 + Secrets Manager

A troca de ferramenta (CDK -> Terraform) não muda a recomendação de arquitetura para esse cenário.
