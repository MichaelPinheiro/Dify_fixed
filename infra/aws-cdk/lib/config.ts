import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REDIS_SSL_CERT_REQS_VALUES = ['CERT_NONE', 'CERT_OPTIONAL', 'CERT_REQUIRED'] as const;
const PLUGIN_DB_SSL_MODE_VALUES = ['disable', 'require'] as const;

type RedisSslCertReqs = (typeof REDIS_SSL_CERT_REQS_VALUES)[number];
type PluginDbSslMode = (typeof PLUGIN_DB_SSL_MODE_VALUES)[number];

export interface ServiceSizing {
  cpu: number;
  memoryMiB: number;
  desiredCount: number;
  minCount: number;
  maxCount: number;
}

export interface EcsEc2Config {
  instanceType: string;
  desiredInstances: number;
  minInstances: number;
  maxInstances: number;
  useSpotInstances: boolean;
  spotMaxPrice?: string;
}

export interface DeploymentConfig {
  appName: string;
  environment: {
    account: string;
    region: string;
  };
  network: {
    vpcId?: string;
    maxAzs: number;
    natGateways: number;
    allowedIpv4Cidrs: string[];
    allowPublicIngress: boolean;
  };
  domain?: {
    hostedZoneName: string;
    subdomain: string;
    certificateArn?: string;
  };
  enableExecuteCommand: boolean;
  ecsEc2: EcsEc2Config;
  images: {
    api: string;
    web: string;
    sandbox: string;
    pluginDaemon: string;
    ssrfProxy: string;
  };
  storage: {
    bucketName?: string;
    forceDestroy: boolean;
    useManagedIamForS3: boolean;
  };
  database: {
    defaultDatabaseName: string;
    pluginDatabaseName: string;
    pgvectorDatabaseName: string;
    minAcu: number;
    maxAcu: number;
    backupRetentionDays: number;
    deletionProtection: boolean;
    pluginDbSslMode: PluginDbSslMode;
  };
  redis: {
    nodeType: string;
    multiAz: boolean;
    replicasPerNodeGroup: number;
    sslCertReqs: RedisSslCertReqs;
  };
  services: {
    web: ServiceSizing;
    api: ServiceSizing;
    worker: ServiceSizing;
    workerBeat: ServiceSizing;
    sandbox: ServiceSizing;
    pluginDaemon: ServiceSizing;
    ssrfProxy: ServiceSizing;
  };
  app: {
    logLevel: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
    migrationEnabledOnApi: boolean;
    corsAllowOrigins: string;
    allowWildcardCors: boolean;
    enableMarketplace: boolean;
    textGenerationTimeoutMs: number;
    gunicornTimeoutSeconds: number;
    celeryWorkerAmount: number;
    celeryAutoScale: boolean;
    celeryMaxWorkers?: number;
    celeryMinWorkers?: number;
    pluginMaxExecutionTimeoutSeconds: number;
    additionalEnvironmentVariables?: Record<string, string>;
  };
}

export function loadConfig(configPath: string): DeploymentConfig {
  const absPath = resolve(configPath);
  const content = readFileSync(absPath, 'utf-8');
  const parsed = JSON.parse(content) as DeploymentConfig;
  const errors: string[] = [];

  if (!parsed.network) {
    errors.push('network configuration is required');
  } else {
    parsed.network.allowPublicIngress ??= false;
  }

  if (!parsed.database) {
    errors.push('database configuration is required');
  } else {
    parsed.database.pluginDbSslMode ??= 'require';
  }

  if (!parsed.redis) {
    errors.push('redis configuration is required');
  } else {
    parsed.redis.sslCertReqs ??= 'CERT_REQUIRED';
  }

  if (!parsed.app) {
    errors.push('app configuration is required');
  } else {
    parsed.app.allowWildcardCors ??= false;
  }

  if (!parsed.appName) {
    errors.push('appName is required');
  }
  if (!parsed.environment?.account || !parsed.environment?.region) {
    errors.push('environment.account and environment.region are required');
  }

  if (!parsed.network?.allowedIpv4Cidrs?.length) {
    errors.push('network.allowedIpv4Cidrs must contain at least one CIDR');
  } else if (!parsed.network.allowPublicIngress && parsed.network.allowedIpv4Cidrs.includes('0.0.0.0/0')) {
    errors.push('network.allowedIpv4Cidrs cannot include 0.0.0.0/0 unless network.allowPublicIngress=true');
  }

  if (parsed.app && !parsed.app.allowWildcardCors && parsed.app.corsAllowOrigins.trim() === '*') {
    errors.push('app.corsAllowOrigins cannot be "*" unless app.allowWildcardCors=true');
  }

  if (parsed.redis && !REDIS_SSL_CERT_REQS_VALUES.includes(parsed.redis.sslCertReqs)) {
    errors.push(
      `redis.sslCertReqs must be one of: ${REDIS_SSL_CERT_REQS_VALUES.join(', ')}, received: ${parsed.redis.sslCertReqs}`,
    );
  }

  if (parsed.database && !PLUGIN_DB_SSL_MODE_VALUES.includes(parsed.database.pluginDbSslMode)) {
    errors.push(
      `database.pluginDbSslMode must be one of: ${PLUGIN_DB_SSL_MODE_VALUES.join(', ')}, received: ${parsed.database.pluginDbSslMode}`,
    );
  }

  const servicesByName = Object.entries(parsed.services ?? {}) as Array<[string, ServiceSizing]>;
  if (!servicesByName.length) {
    errors.push('services configuration is required');
  }
  for (const [serviceName, sizing] of servicesByName) {
    if (sizing.minCount > sizing.desiredCount || sizing.desiredCount > sizing.maxCount) {
      errors.push(
        `services.${serviceName} must satisfy minCount <= desiredCount <= maxCount (received ${sizing.minCount} <= ${sizing.desiredCount} <= ${sizing.maxCount})`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`config validation failed:\n- ${errors.join('\n- ')}`);
  }

  return parsed;
}
