import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Handler } from './handler.ts';

export interface ServerOptions {
  maxBodyBytes?: number;
  trustProxy?: boolean;
  onError?: (error: unknown) => void;
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const last = value?.split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

export function createHttpServer(handler: Handler, options: ServerOptions = {}): Server {
  const maxBody = options.maxBodyBytes ?? 1_500_000;
  const trustProxy = options.trustProxy ?? false;

  const server = createServer((request, response) => {
    const send = (status: number, headers: Record<string, string>, body: string): void => {
      response.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
      response.end(body);
    };
    const tooLarge = (): void =>
      send(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }, JSON.stringify({ error: { code: 'REQUEST_TOO_LARGE', message: 'The request is too large.' } }));

    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      tooLarge();
      request.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    request.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBody) {
        aborted = true;
        tooLarge();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (aborted) return;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      handler({
        method: request.method ?? 'GET',
        path,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
        ip: clientIp(request, trustProxy),
      })
        .then((result) => send(result.status, result.headers, result.body))
        .catch((error: unknown) => {
          options.onError?.(error);
          send(500, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }));
        });
    });

    request.on('error', () => {
      aborted = true;
    });
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
