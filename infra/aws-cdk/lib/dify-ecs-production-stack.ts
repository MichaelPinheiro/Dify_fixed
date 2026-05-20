import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { join } from 'node:path';
import { Construct } from 'constructs';
import { DeploymentConfig, ServiceSizing } from './config';

export interface DifyEcsProductionStackProps extends cdk.StackProps {
  config: DeploymentConfig;
}

export class DifyEcsProductionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DifyEcsProductionStackProps) {
    super(scope, id, props);

    const cfg = props.config;

    const vpc = cfg.network.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: cfg.network.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: cfg.network.maxAzs,
          natGateways: cfg.network.natGateways,
          subnetConfiguration: [
            {
              name: 'Public',
              subnetType: ec2.SubnetType.PUBLIC,
            },
            {
              name: 'Private',
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
          ],
        });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'ALB security group',
      allowAllOutbound: true,
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'ECS tasks security group',
      allowAllOutbound: true,
    });

    const instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'ECS container instances security group',
      allowAllOutbound: true,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Aurora security group',
      allowAllOutbound: true,
    });

    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'ElastiCache security group',
      allowAllOutbound: true,
    });

    serviceSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.allTcp(), 'Allow task-to-task communication');
    dbSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(5432), 'Allow ECS tasks to Aurora');
    redisSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(6379), 'Allow ECS tasks to Redis');

    const storageBucket = new s3.Bucket(this, 'StorageBucket', {
      bucketName: cfg.storage.bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cfg.storage.forceDestroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: cfg.storage.forceDestroy,
    });

    const createPluginsPlaceholder = new AwsCustomResource(this, 'CreatePluginsPlaceholder', {
      onUpdate: {
        service: 's3',
        action: 'putObject',
        parameters: {
          Bucket: storageBucket.bucketName,
          Key: 'plugins',
          Body: 'placeholder. see https://github.com/langgenius/dify-plugin-daemon/issues/35',
        },
        physicalResourceId: PhysicalResourceId.of(`plugins-placeholder-${cfg.appName}`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [storageBucket.bucketArn, storageBucket.arnForObjects('*')],
      }),
    });

    const postgres = new rds.DatabaseCluster(this, 'PostgresCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_12,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
        autoMinorVersionUpgrade: true,
      }),
      defaultDatabaseName: cfg.database.defaultDatabaseName,
      serverlessV2MinCapacity: cfg.database.minAcu,
      serverlessV2MaxCapacity: cfg.database.maxAcu,
      backup: {
        retention: cdk.Duration.days(cfg.database.backupRetentionDays),
      },
      deletionProtection: cfg.database.deletionProtection,
      storageEncrypted: true,
      enableDataApi: true,
      vpc,
      securityGroups: [dbSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      removalPolicy: cfg.database.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const runSql = (idSuffix: string, sql: string, database?: string): AwsCustomResource => {
      const resource = new AwsCustomResource(this, idSuffix, {
        onUpdate: {
          service: 'rds-data',
          action: 'ExecuteStatement',
          parameters: {
            resourceArn: postgres.clusterArn,
            secretArn: postgres.secret!.secretArn,
            database,
            sql,
          },
          physicalResourceId: PhysicalResourceId.of(`${idSuffix}-${cfg.appName}`),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: [postgres.clusterArn, `${postgres.clusterArn}:*`],
        }),
      });
      postgres.secret!.grantRead(resource);
      postgres.grantDataApiAccess(resource);
      return resource;
    };

    const createPgVectorDb = runSql(
      'CreatePgVectorDatabase',
      `CREATE DATABASE ${cfg.database.pgvectorDatabaseName};`,
      cfg.database.defaultDatabaseName,
    );

    const createPluginDb = runSql(
      'CreatePluginDatabase',
      `CREATE DATABASE ${cfg.database.pluginDatabaseName};`,
      cfg.database.defaultDatabaseName,
    );

    const createPgVectorExtension = runSql(
      'CreatePgVectorExtension',
      'CREATE EXTENSION IF NOT EXISTS vector;',
      cfg.database.pgvectorDatabaseName,
    );
    createPgVectorExtension.node.addDependency(createPgVectorDb);

    const redisAuthToken = new secretsmanager.Secret(this, 'RedisAuthToken', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 30,
      },
    });

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Dify Redis',
      subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
    });

    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      engine: 'Valkey',
      engineVersion: '8.0',
      cacheNodeType: cfg.redis.nodeType,
      replicationGroupDescription: `${cfg.appName} redis`,
      numNodeGroups: 1,
      replicasPerNodeGroup: cfg.redis.replicasPerNodeGroup,
      automaticFailoverEnabled: cfg.redis.multiAz,
      multiAzEnabled: cfg.redis.multiAz,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      authToken: redisAuthToken.secretValue.unsafeUnwrap(),
      port: 6379,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
    });

    const redisEndpoint = redis.attrPrimaryEndPointAddress;
    const redisPort = 6379;

    const celeryBrokerUrl = new ssm.StringParameter(this, 'CeleryBrokerUrl', {
      stringValue: `rediss://:${redisAuthToken.secretValue.unsafeUnwrap()}@${redisEndpoint}:${redisPort}/1?ssl_cert_reqs=optional`,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsights: true,
    });

    const containerInstanceRole = new iam.Role(this, 'ContainerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
      vpc,
      instanceType: new ec2.InstanceType(cfg.ecsEc2.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      role: containerInstanceRole,
      minCapacity: cfg.ecsEc2.minInstances,
      desiredCapacity: cfg.ecsEc2.desiredInstances,
      maxCapacity: cfg.ecsEc2.maxInstances,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      spotPrice: cfg.ecsEc2.useSpotInstances ? cfg.ecsEc2.spotMaxPrice : undefined,
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });
    asg.addSecurityGroup(instanceSecurityGroup);
    asg.addUserData(
      `echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_ENABLE_CONTAINER_METADATA=true >> /etc/ecs/ecs.config',
    );

    const asgCapacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      spotInstanceDraining: cfg.ecsEc2.useSpotInstances,
    });
    cluster.addAsgCapacityProvider(asgCapacityProvider);

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      vpc,
      name: `${cfg.appName}.internal`,
    });

    const appSecretKey = new secretsmanager.Secret(this, 'AppSecretKey', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 42,
      },
    });

    const codeExecutionApiKey = new secretsmanager.Secret(this, 'CodeExecutionApiKey', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 42,
      },
    });

    const pluginInnerApiKey = new secretsmanager.Secret(this, 'PluginInnerApiKey', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 42,
      },
    });

    const pluginServerKey = new secretsmanager.Secret(this, 'PluginServerKey', {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 42,
      },
    });

    const appHost = cfg.domain ? `${cfg.domain.subdomain}.${cfg.domain.hostedZoneName}` : undefined;

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(600),
    });

    const allowCidrIngress = (port: number): void => {
      for (const cidr of cfg.network.allowedIpv4Cidrs) {
        albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(port), `Allow ${port} from ${cidr}`);
      }
    };

    let listener: elbv2.ApplicationListener;
    if (cfg.domain) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: cfg.domain.hostedZoneName,
      });
      const certificate = cfg.domain.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', cfg.domain.certificateArn)
        : new acm.Certificate(this, 'Certificate', {
            domainName: appHost!,
            validation: acm.CertificateValidation.fromDns(hostedZone),
          });

      listener = alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(404),
      });
      allowCidrIngress(443);

      const httpRedirect = alb.addListener('HttpRedirectListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
      for (const cidr of cfg.network.allowedIpv4Cidrs) {
        httpRedirect.connections.allowFrom(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80));
      }

      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: cfg.domain.subdomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });
    } else {
      listener = alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(404),
      });
      allowCidrIngress(80);
    }

    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'ALB -> web');
    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(5001), 'ALB -> api');
    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(5002), 'ALB -> plugin daemon');

    const publicBaseUrl = appHost ? `https://${appHost}` : `http://${alb.loadBalancerDnsName}`;
    const namespaceDomain = namespace.namespaceName;
    const apiInternalUrl = `http://api.${namespaceDomain}:5001`;
    const pluginInternalUrl = `http://plugin-daemon.${namespaceDomain}:5002`;
    const sandboxInternalUrl = `http://sandbox.${namespaceDomain}:8194`;
    const ssrfProxyUrl = `http://ssrf-proxy.${namespaceDomain}:3128`;

    const commonApiWorkerEnv: Record<string, string> = {
      LOG_LEVEL: cfg.app.logLevel,
      DEBUG: 'false',
      CONSOLE_WEB_URL: publicBaseUrl,
      CONSOLE_API_URL: publicBaseUrl,
      SERVICE_API_URL: publicBaseUrl,
      APP_WEB_URL: publicBaseUrl,
      APP_API_URL: publicBaseUrl,
      TRIGGER_URL: publicBaseUrl,
      FILES_URL: publicBaseUrl,
      INTERNAL_FILES_URL: apiInternalUrl,
      DEPLOY_ENV: 'PRODUCTION',
      STORAGE_TYPE: 's3',
      S3_BUCKET_NAME: storageBucket.bucketName,
      S3_REGION: this.region,
      S3_USE_AWS_MANAGED_IAM: cfg.storage.useManagedIamForS3 ? 'true' : 'false',
      DB_TYPE: 'postgresql',
      DB_DATABASE: cfg.database.defaultDatabaseName,
      VECTOR_STORE: 'pgvector',
      PGVECTOR_DATABASE: cfg.database.pgvectorDatabaseName,
      REDIS_HOST: redisEndpoint,
      REDIS_PORT: redisPort.toString(),
      REDIS_USE_SSL: 'true',
      REDIS_DB: '0',
      CELERY_BACKEND: 'redis',
      WEB_API_CORS_ALLOW_ORIGINS: cfg.app.corsAllowOrigins,
      CONSOLE_CORS_ALLOW_ORIGINS: cfg.app.corsAllowOrigins,
      SQLALCHEMY_POOL_PRE_PING: 'True',
      GUNICORN_TIMEOUT: cfg.app.gunicornTimeoutSeconds.toString(),
      CELERY_WORKER_AMOUNT: cfg.app.celeryWorkerAmount.toString(),
      CELERY_AUTO_SCALE: cfg.app.celeryAutoScale ? 'true' : 'false',
      PLUGIN_DAEMON_URL: pluginInternalUrl,
      CODE_EXECUTION_ENDPOINT: sandboxInternalUrl,
      SSRF_PROXY_HTTP_URL: ssrfProxyUrl,
      SSRF_PROXY_HTTPS_URL: ssrfProxyUrl,
      MARKETPLACE_ENABLED: cfg.app.enableMarketplace ? 'true' : 'false',
      MARKETPLACE_API_URL: 'https://marketplace.dify.ai',
      MARKETPLACE_URL: 'https://marketplace.dify.ai',
      TEXT_GENERATION_TIMEOUT_MS: cfg.app.textGenerationTimeoutMs.toString(),
      ENDPOINT_URL_TEMPLATE: `${publicBaseUrl}/e/{hook_id}`,
      PLUGIN_DAEMON_TIMEOUT: cfg.app.pluginMaxExecutionTimeoutSeconds.toString(),
      PLUGIN_MAX_EXECUTION_TIMEOUT: cfg.app.pluginMaxExecutionTimeoutSeconds.toString(),
      ...cfg.app.additionalEnvironmentVariables,
    };

    if (cfg.app.celeryMaxWorkers != null) {
      commonApiWorkerEnv.CELERY_MAX_WORKERS = cfg.app.celeryMaxWorkers.toString();
    }
    if (cfg.app.celeryMinWorkers != null) {
      commonApiWorkerEnv.CELERY_MIN_WORKERS = cfg.app.celeryMinWorkers.toString();
    }

    const commonSecrets: Record<string, ecs.Secret> = {
      DB_USERNAME: ecs.Secret.fromSecretsManager(postgres.secret!, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret!, 'password'),
      DB_HOST: ecs.Secret.fromSecretsManager(postgres.secret!, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(postgres.secret!, 'port'),
      PGVECTOR_USER: ecs.Secret.fromSecretsManager(postgres.secret!, 'username'),
      PGVECTOR_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret!, 'password'),
      PGVECTOR_HOST: ecs.Secret.fromSecretsManager(postgres.secret!, 'host'),
      PGVECTOR_PORT: ecs.Secret.fromSecretsManager(postgres.secret!, 'port'),
      REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisAuthToken),
      CELERY_BROKER_URL: ecs.Secret.fromSsmParameter(celeryBrokerUrl),
      SECRET_KEY: ecs.Secret.fromSecretsManager(appSecretKey),
      CODE_EXECUTION_API_KEY: ecs.Secret.fromSecretsManager(codeExecutionApiKey),
      INNER_API_KEY_FOR_PLUGIN: ecs.Secret.fromSecretsManager(pluginInnerApiKey),
      PLUGIN_DAEMON_KEY: ecs.Secret.fromSecretsManager(pluginServerKey),
    };

    const makeAwsLogs = (prefix: string): ecs.LogDriver =>
      ecs.LogDriver.awsLogs({
        streamPrefix: prefix,
        logRetention: logs.RetentionDays.ONE_MONTH,
      });

    const createTaskDefinition = (id: string): ecs.Ec2TaskDefinition => {
      const executionRole = new iam.Role(this, `${id}TaskExecutionRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
      });

      const taskRole = new iam.Role(this, `${id}TaskRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });

      return new ecs.Ec2TaskDefinition(this, `${id}TaskDefinition`, {
        executionRole,
        taskRole,
        networkMode: ecs.NetworkMode.AWS_VPC,
      });
    };

    const createService = (
      id: string,
      taskDefinition: ecs.Ec2TaskDefinition,
      sizing: ServiceSizing,
      cloudMapName: string,
    ): ecs.Ec2Service => {
      return new ecs.Ec2Service(this, `${id}Service`, {
        cluster,
        taskDefinition,
        desiredCount: sizing.desiredCount,
        securityGroups: [serviceSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        enableExecuteCommand: cfg.enableExecuteCommand,
        capacityProviderStrategies: [
          {
            capacityProvider: asgCapacityProvider.capacityProviderName,
            weight: 1,
          },
        ],
        cloudMapOptions: {
          cloudMapNamespace: namespace,
          name: cloudMapName,
        },
      });
    };

    const applyAutoscaling = (service: ecs.Ec2Service, idPrefix: string, sizing: ServiceSizing): void => {
      const scalable = service.autoScaleTaskCount({
        minCapacity: sizing.minCount,
        maxCapacity: sizing.maxCount,
      });
      scalable.scaleOnCpuUtilization(`${idPrefix}CpuScaling`, {
        targetUtilizationPercent: 65,
        scaleInCooldown: cdk.Duration.seconds(120),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });
      scalable.scaleOnMemoryUtilization(`${idPrefix}MemoryScaling`, {
        targetUtilizationPercent: 70,
        scaleInCooldown: cdk.Duration.seconds(120),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });
    };

    const apiTask = createTaskDefinition('Api');
    const apiContainer = apiTask.addContainer('ApiContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.api),
      cpu: cfg.services.api.cpu,
      memoryLimitMiB: cfg.services.api.memoryMiB,
      environment: {
        ...commonApiWorkerEnv,
        MODE: 'api',
        MIGRATION_ENABLED: cfg.app.migrationEnabledOnApi ? 'true' : 'false',
      },
      secrets: commonSecrets,
      logging: makeAwsLogs('api'),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:5001/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 8,
        startPeriod: cdk.Duration.seconds(90),
      },
    });
    apiContainer.addPortMappings({ containerPort: 5001 });

    const apiService = createService('Api', apiTask, cfg.services.api, 'api');
    storageBucket.grantReadWrite(apiTask.taskRole);
    postgres.connections.allowDefaultPortFrom(apiService);

    const workerTask = createTaskDefinition('Worker');
    workerTask.addContainer('WorkerContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.api),
      cpu: cfg.services.worker.cpu,
      memoryLimitMiB: cfg.services.worker.memoryMiB,
      environment: {
        ...commonApiWorkerEnv,
        MODE: 'worker',
        MIGRATION_ENABLED: 'false',
      },
      secrets: commonSecrets,
      logging: makeAwsLogs('worker'),
    });

    const workerService = createService('Worker', workerTask, cfg.services.worker, 'worker');
    storageBucket.grantReadWrite(workerTask.taskRole);
    postgres.connections.allowDefaultPortFrom(workerService);

    const workerBeatTask = createTaskDefinition('WorkerBeat');
    workerBeatTask.addContainer('WorkerBeatContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.api),
      cpu: cfg.services.workerBeat.cpu,
      memoryLimitMiB: cfg.services.workerBeat.memoryMiB,
      environment: {
        ...commonApiWorkerEnv,
        MODE: 'beat',
        MIGRATION_ENABLED: 'false',
      },
      secrets: commonSecrets,
      logging: makeAwsLogs('worker-beat'),
    });

    const workerBeatService = createService('WorkerBeat', workerBeatTask, cfg.services.workerBeat, 'worker-beat');
    storageBucket.grantReadWrite(workerBeatTask.taskRole);
    postgres.connections.allowDefaultPortFrom(workerBeatService);

    const sandboxTask = createTaskDefinition('Sandbox');
    const sandboxContainer = sandboxTask.addContainer('SandboxContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.sandbox),
      cpu: cfg.services.sandbox.cpu,
      memoryLimitMiB: cfg.services.sandbox.memoryMiB,
      environment: {
        GIN_MODE: 'release',
        WORKER_TIMEOUT: '15',
        ENABLE_NETWORK: 'true',
        SANDBOX_PORT: '8194',
        HTTP_PROXY: ssrfProxyUrl,
        HTTPS_PROXY: ssrfProxyUrl,
      },
      secrets: {
        API_KEY: ecs.Secret.fromSecretsManager(codeExecutionApiKey),
      },
      logging: makeAwsLogs('sandbox'),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8194/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    sandboxContainer.addPortMappings({ containerPort: 8194 });

    const sandboxService = createService('Sandbox', sandboxTask, cfg.services.sandbox, 'sandbox');

    const pluginTask = createTaskDefinition('PluginDaemon');
    const pluginContainer = pluginTask.addContainer('PluginDaemonContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.pluginDaemon),
      cpu: cfg.services.pluginDaemon.cpu,
      memoryLimitMiB: cfg.services.pluginDaemon.memoryMiB,
      environment: {
        LOG_OUTPUT_FORMAT: 'text',
        DB_DATABASE: cfg.database.pluginDatabaseName,
        DB_SSL_MODE: 'disable',
        REDIS_HOST: redisEndpoint,
        REDIS_PORT: redisPort.toString(),
        REDIS_USE_SSL: 'true',
        SERVER_PORT: '5002',
        DIFY_INNER_API_URL: apiInternalUrl,
        PLUGIN_STORAGE_TYPE: 'aws_s3',
        PLUGIN_STORAGE_OSS_BUCKET: storageBucket.bucketName,
        PLUGIN_INSTALLED_PATH: 'plugins',
        PLUGIN_WORKING_PATH: '/app/storage/cwd',
        PLUGIN_MAX_EXECUTION_TIMEOUT: cfg.app.pluginMaxExecutionTimeoutSeconds.toString(),
        MAX_PLUGIN_PACKAGE_SIZE: '52428800',
        MAX_BUNDLE_PACKAGE_SIZE: '52428800',
        PLUGIN_REMOTE_INSTALLING_ENABLED: 'true',
        PLUGIN_REMOTE_INSTALLING_HOST: 'localhost',
        PLUGIN_REMOTE_INSTALLING_PORT: '5003',
        S3_USE_AWS_MANAGED_IAM: cfg.storage.useManagedIamForS3 ? 'true' : 'false',
        S3_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
        AWS_REGION: this.region,
        FORCE_VERIFYING_SIGNATURE: 'true',
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(postgres.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret!, 'password'),
        DB_HOST: ecs.Secret.fromSecretsManager(postgres.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(postgres.secret!, 'port'),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisAuthToken),
        CELERY_BROKER_URL: ecs.Secret.fromSsmParameter(celeryBrokerUrl),
        DIFY_INNER_API_KEY: ecs.Secret.fromSecretsManager(pluginInnerApiKey),
        SERVER_KEY: ecs.Secret.fromSecretsManager(pluginServerKey),
      },
      logging: makeAwsLogs('plugin-daemon'),
    });
    pluginContainer.addPortMappings({ containerPort: 5002 });

    const pluginService = createService('PluginDaemon', pluginTask, cfg.services.pluginDaemon, 'plugin-daemon');
    storageBucket.grantReadWrite(pluginTask.taskRole);
    postgres.connections.allowDefaultPortFrom(pluginService);

    const ssrfTask = createTaskDefinition('SsrfProxy');
    const ssrfProxyImage =
      cfg.images.ssrfProxy === 'asset'
        ? ecs.ContainerImage.fromAsset(join(__dirname, '..', 'assets', 'ssrf-proxy'), {
            platform: Platform.LINUX_AMD64,
          })
        : ecs.ContainerImage.fromRegistry(cfg.images.ssrfProxy);

    const ssrfContainer = ssrfTask.addContainer('SsrfProxyContainer', {
      image: ssrfProxyImage,
      cpu: cfg.services.ssrfProxy.cpu,
      memoryLimitMiB: cfg.services.ssrfProxy.memoryMiB,
      environment: {
        HTTP_PORT: '3128',
        COREDUMP_DIR: '/var/spool/squid',
        REVERSE_PROXY_PORT: '8194',
        SANDBOX_HOST: `sandbox.${namespaceDomain}`,
        SANDBOX_PORT: '8194',
      },
      logging: makeAwsLogs('ssrf-proxy'),
    });
    ssrfContainer.addPortMappings({ containerPort: 3128 });

    const ssrfService = createService('SsrfProxy', ssrfTask, cfg.services.ssrfProxy, 'ssrf-proxy');
    ssrfService.node.addDependency(sandboxService);

    const webTask = createTaskDefinition('Web');
    const webContainer = webTask.addContainer('WebContainer', {
      image: ecs.ContainerImage.fromRegistry(cfg.images.web),
      cpu: cfg.services.web.cpu,
      memoryLimitMiB: cfg.services.web.memoryMiB,
      environment: {
        LOG_LEVEL: cfg.app.logLevel,
        DEBUG: 'false',
        CONSOLE_API_URL: publicBaseUrl,
        APP_API_URL: publicBaseUrl,
        HOSTNAME: '0.0.0.0',
        PORT: '3000',
        MARKETPLACE_API_URL: 'https://marketplace.dify.ai',
        MARKETPLACE_URL: 'https://marketplace.dify.ai',
      },
      logging: makeAwsLogs('web'),
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1'],
        interval: cdk.Duration.seconds(20),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(30),
      },
    });
    webContainer.addPortMappings({ containerPort: 3000 });

    const webService = createService('Web', webTask, cfg.services.web, 'web');
    storageBucket.grantReadWrite(webTask.taskRole);

    const webTarget = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 3000,
      targets: [webService],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200-399',
      },
    });

    const apiTarget = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 5001,
      targets: [apiService],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200-399',
      },
    });

    const pluginTarget = new elbv2.ApplicationTargetGroup(this, 'PluginTargetGroup', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 5002,
      targets: [pluginService.loadBalancerTarget({ containerName: 'PluginDaemonContainer', containerPort: 5002 })],
      healthCheck: {
        path: '/health/check',
        healthyHttpCodes: '200-399',
      },
    });

    listener.addTargetGroups('ApiRoutes', {
      priority: 10,
      targetGroups: [apiTarget],
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api',
          '/api/*',
          '/v1',
          '/v1/*',
          '/console/api',
          '/console/api/*',
          '/files',
          '/files/*',
          '/triggers',
          '/triggers/*',
        ]),
      ],
    });

    listener.addTargetGroups('PluginRoutes', {
      priority: 20,
      targetGroups: [pluginTarget],
      conditions: [elbv2.ListenerCondition.pathPatterns(['/e', '/e/*'])],
    });

    listener.addTargetGroups('WebRoutes', {
      priority: 30,
      targetGroups: [webTarget],
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
    });

    applyAutoscaling(apiService, 'Api', cfg.services.api);
    applyAutoscaling(workerService, 'Worker', cfg.services.worker);
    applyAutoscaling(webService, 'Web', cfg.services.web);

    apiService.node.addDependency(createPgVectorExtension);
    workerService.node.addDependency(createPgVectorExtension);
    workerBeatService.node.addDependency(createPgVectorExtension);
    pluginService.node.addDependency(createPluginDb);
    pluginService.node.addDependency(createPluginsPlaceholder);

    apiTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:GetInferenceProfile',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:ListFoundationModels',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
          'bedrock:Rerank',
        ],
        resources: ['*'],
      }),
    );

    new cdk.CfnOutput(this, 'DifyUrl', {
      value: publicBaseUrl,
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'StorageBucketName', {
      value: storageBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'PostgresSecretName', {
      value: postgres.secret!.secretName,
    });

    new cdk.CfnOutput(this, 'RedisAuthSecretName', {
      value: redisAuthToken.secretName,
    });

    new cdk.CfnOutput(this, 'Namespace', {
      value: namespace.namespaceName,
    });

    new cdk.CfnOutput(this, 'EcsAutoScalingGroupName', {
      value: asg.autoScalingGroupName,
    });
  }
}
