import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  };
  redis: {
    nodeType: string;
    multiAz: boolean;
    replicasPerNodeGroup: number;
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

  if (!parsed.appName) {
    throw new Error('config validation failed: appName is required');
  }
  if (!parsed.environment?.account || !parsed.environment?.region) {
    throw new Error('config validation failed: environment.account and environment.region are required');
  }

  return parsed;
}
