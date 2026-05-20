#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { DifyEcsProductionStack } from '../lib/dify-ecs-production-stack';

const configPath = process.env.DIFY_CDK_CONFIG ?? './config/production.example.json';
const config = loadConfig(configPath);

const app = new cdk.App();

new DifyEcsProductionStack(app, `${config.appName}-stack`, {
  env: {
    account: config.environment.account,
    region: config.environment.region,
  },
  config,
  description: 'Dify fork production deployment on AWS ECS/Fargate',
});
