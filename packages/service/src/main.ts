#!/usr/bin/env node
import process from 'node:process';
import {
  createGithubChangelogSource,
  createMemoryCache,
  createNpmStatsSource,
  createOpenAiCompatibleProvider,
  createRegistryClient,
  withCache,
  withChangelogCache,
  withManifestCache,
} from '@dependency-radar/core';
import type { AiProvider } from '@dependency-radar/core';
import { buildDemoReport } from './demo.ts';
import { createHandler } from './handler.ts';
import { createDailyBudget, createRateLimiter } from './limits.ts';
import { createHttpServer } from './server.ts';
import { createAnalyzeService } from './service.ts';

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function serverAiFromEnv(env: NodeJS.ProcessEnv): AiProvider | undefined {
  const baseUrl = env.RADAR_AI_BASE_URL?.trim();
  const apiKey = env.RADAR_AI_KEY?.trim();
  const model = env.RADAR_AI_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  return createOpenAiCompatibleProvider({ baseUrl, apiKey, model });
}

const env = process.env;
const npm = createRegistryClient();
const serverAi = serverAiFromEnv(env);
const token = env.GITHUB_TOKEN?.trim();

const service = createAnalyzeService({
  registry: withCache(npm, createMemoryCache({ maxEntries: 500 })),
  manifests: withManifestCache(npm),
  changelogs: withChangelogCache(createGithubChangelogSource(token ? { token } : {})),
  stats: createNpmStatsSource(),
  ...(serverAi ? { serverAi, aiBudget: createDailyBudget({ limit: number(env.DAILY_AI_BUDGET, 100) }) } : {}),
});

const handler = createHandler({
  service,
  limiter: createRateLimiter({ limit: number(env.RATE_LIMIT_PER_HOUR, 20), windowMs: 60 * 60 * 1000 }),
  demo: () => buildDemoReport(),
  serverAiEnabled: serverAi !== undefined,
  onEvent: (event) => console.log(JSON.stringify({ ...event, at: new Date().toISOString() })),
});

const server = createHttpServer(handler, {
  trustProxy: env.TRUST_PROXY === '1',
  onError: (error) => console.error('Unhandled error', error instanceof Error ? error.name : 'unknown'),
});

const port = number(env.PORT, 8080);
const host = env.HOST ?? '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Dependency Radar listening on http://${host}:${port} (server AI: ${serverAi ? 'on' : 'off'}, GitHub token: ${token ? 'set' : 'not set'})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
