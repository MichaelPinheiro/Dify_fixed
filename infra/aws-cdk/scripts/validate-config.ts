import { loadConfig } from '../lib/config';

const configPath = process.argv[2] ?? process.env.DIFY_CDK_CONFIG ?? './config/production.example.json';

try {
  const config = loadConfig(configPath);
  process.stdout.write(
    `Config validation passed for "${configPath}" (appName=${config.appName}, region=${config.environment.region})\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Config validation failed for "${configPath}"\n${message}\n`);
  process.exit(1);
}
