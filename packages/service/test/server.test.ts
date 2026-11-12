import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { demoDeps, DEMO_PACKAGE_JSON } from '../src/demo.ts';
import { createHandler } from '../src/handler.ts';
import type { Handler } from '../src/handler.ts';
import { createRateLimiter } from '../src/limits.ts';
import { createHttpServer } from '../src/server.ts';
import { createAnalyzeService } from '../src/service.ts';

const servers: Array<ReturnType<typeof createHttpServer>> = [];
after(() => {
  for (const server of servers) server.close();
});

async function start(options: { handler?: Handler; trustProxy?: boolean; maxBodyBytes?: number; limit?: number } = {}) {
  const service = createAnalyzeService({
    registry: demoDeps.registry,
    manifests: demoDeps.manifests,
    changelogs: demoDeps.changelogs,
  });
  const handler =
    options.handler ??
    createHandler({
      service,
      limiter: createRateLimiter({ limit: options.limit ?? 100, windowMs: 3_600_000 }),
      demo: async () => {
        throw new Error('not used');
      },
      serverAiEnabled: false,
    });
  const server = createHttpServer(handler, {
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('createHttpServer', () => {
  it('serves health checks and the form over real HTTP', async () => {
    const url = await start();
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await home.text(), /Dependency Radar/);
  });

  it('analyzes a request end to end', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packageJson: DEMO_PACKAGE_JSON }),
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as { results: unknown[] };
    assert.equal(data.results.length, 7);
  });

  it('refuses bodies that are too large', async () => {
    const url = await start({ maxBodyBytes: 1000 });
    const response = await fetch(`${url}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packageJson: 'x'.repeat(5000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'REQUEST_TOO_LARGE');
  });

  it('keys rate limits on the real address unless the proxy is trusted', async () => {
    const post = (url: string, forwarded?: string) =>
      fetch(`${url}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
        body: JSON.stringify({ packageJson: '{}' }),
      });

    const direct = await start({ limit: 1 });
    assert.equal((await post(direct, '1.1.1.1')).status, 200);
    assert.equal((await post(direct, '2.2.2.2')).status, 429);

    const proxied = await start({ limit: 1, trustProxy: true });
    assert.equal((await post(proxied, 'spoofed, 1.1.1.1')).status, 200);
    assert.equal((await post(proxied, 'other, 1.1.1.1')).status, 429);
    assert.equal((await post(proxied, 'other, 2.2.2.2')).status, 200);
  });

  it('hides the details of unexpected errors', async () => {
    const url = await start({
      handler: async () => {
        throw new Error('database password is hunter2');
      },
    });
    const response = await fetch(`${url}/anything`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(text.includes('hunter2'), false);
    assert.match(text, /INTERNAL_ERROR/);
  });

  it('ignores the query string when routing', async () => {
    const url = await start();
    assert.equal((await fetch(`${url}/health?x=1`)).status, 200);
  });
});
