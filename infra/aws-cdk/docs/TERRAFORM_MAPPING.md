# Mapeamento da Arquitetura CDK para Terraform

Este documento facilita migrar ou reproduzir esta arquitetura em Terraform.

## Mapeamento de recursos

- VPC/Subnets/NAT:
  - CDK: `aws-ec2.Vpc`
  - Terraform: `aws_vpc`, `aws_subnet`, `aws_nat_gateway`, `aws_internet_gateway`, `aws_route_table`

- ECS Cluster + EC2 Capacity Provider:
  - CDK: `ecs.Cluster`, `autoscaling.AutoScalingGroup`, `ecs.AsgCapacityProvider`
  - Terraform: `aws_ecs_cluster`, `aws_launch_template`, `aws_autoscaling_group`, `aws_ecs_capacity_provider`, `aws_ecs_cluster_capacity_providers`

- ECS account settings (recomendado para task density):
  - CDK: habilitado manualmente por script (`enable-awsvpc-trunking.sh`)
  - Terraform: `aws_ecs_account_setting_default` com `name = "awsvpcTrunking"` e `value = "enabled"`

- ECS Task Definitions / Services:
  - CDK: `ecs.Ec2TaskDefinition`, `ecs.Ec2Service`
  - Terraform: `aws_ecs_task_definition`, `aws_ecs_service`

- Service Discovery (Cloud Map):
  - CDK: `servicediscovery.PrivateDnsNamespace`
  - Terraform: `aws_service_discovery_private_dns_namespace`, `aws_service_discovery_service`

- ALB + listeners + target groups:
  - CDK: `elbv2.ApplicationLoadBalancer`, `ApplicationListener`, `ApplicationTargetGroup`
  - Terraform: `aws_lb`, `aws_lb_listener`, `aws_lb_target_group`, `aws_lb_listener_rule`

- Aurora PostgreSQL:
  - CDK: `rds.DatabaseCluster`
  - Terraform: `aws_rds_cluster`, `aws_rds_cluster_instance`

- ElastiCache Valkey/Redis:
  - CDK: `elasticache.CfnReplicationGroup`
  - Terraform: `aws_elasticache_replication_group`

- S3:
  - CDK: `s3.Bucket`
  - Terraform: `aws_s3_bucket` + recursos auxiliares de versioning/encryption/public access block

- Secrets / Parameters:
  - CDK: `secretsmanager.Secret`, `ssm.StringParameter`
  - Terraform: `aws_secretsmanager_secret`, `aws_secretsmanager_secret_version`, `aws_ssm_parameter`

## Ordem sugerida em Terraform

1. Networking (VPC/subnets/routes/security groups)
2. Dados (Aurora, ElastiCache, S3, secrets)
3. ECS base (cluster, ASG, capacity provider, namespace)
4. Task definitions + services
5. ALB + listeners + rules
6. Autoscaling policies

## Observação

O objetivo é manter paridade de arquitetura com esta branch, não necessariamente 1:1 de implementação.
