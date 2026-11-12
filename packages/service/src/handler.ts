import { formatHtml, formatRiskHtml, riskHeadline } from '@dependency-radar/core';
import type { AiChoice, AnalysisReport, AnalyzeRequest, AnalyzeService, CheckReport } from './service.ts';
import type { RateLimiter } from './limits.ts';
import { HTML_CSP, renderCheckPage, renderErrorPage, renderHomePage } from './pages.ts';
import type { HomeValues } from './pages.ts';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  ip: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Handler = (request: HttpRequest) => Promise<HttpResponse>;

export interface HandlerOptions {
  service: AnalyzeService;
  limiter: RateLimiter;
  demo: () => Promise<AnalysisReport>;
  serverAiEnabled: boolean;
  maxBodyBytes?: number;
  onEvent?: (event: { route: string; status: number; durationMs: number }) => void;
}

const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
};

function html(status: number, body: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, ...extra },
    body,
  };
}

function json(status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
    body: JSON.stringify(value),
  };
}

function jsonError(status: number, code: string, message: string, extra: Record<string, string> = {}): HttpResponse {
  return json(status, { error: { code, message } }, extra);
}

function reportJson(report: AnalysisReport): unknown {
  return {
    source: report.source,
    generatedAt: report.generatedAt,
    fileName: report.fileName,
    lockfileName: report.lockfileName ?? null,
    summary: report.analysis.summary,
    scan: report.scan ?? null,
    warnings: report.warnings,
    notes: report.notes,
    entries: report.entries,
    results: report.analysis.results,
  };
}

function reportHtml(report: AnalysisReport): string {
  return formatHtml(report.entries, report.analysis, report.warnings, {
    fileName: report.fileName,
    ...(report.lockfileName === undefined ? {} : { lockfileName: report.lockfileName }),
    ...(report.scan ? { scan: report.scan } : {}),
    generatedAt: report.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC',
    homeHref: '/',
    ...(report.source === 'demo' ? { banner: 'Sample data for a made-up project. Nothing was sent to npm or GitHub.' } : {}),
    notes: report.notes,
  });
}

function checkJson(check: CheckReport): unknown {
  const headline = riskHeadline(check.report);
  return {
    subject: check.subject,
    generatedAt: check.generatedAt,
    verdict: { title: headline.title, text: headline.text },
    highest: check.report.highest,
    scannedFiles: check.report.scannedFiles,
    checkedDependencies: check.report.checkedDependencies,
    truncated: check.report.truncated,
    signals: check.report.signals,
    limitations: check.report.limitations,
  };
}

function checkHtml(check: CheckReport): string {
  return formatRiskHtml(check.report, {
    subject: check.subject,
    generatedAt: check.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC',
    homeHref: '/check',
  });
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function aiFromObject(value: unknown): AiChoice | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const choice: AiChoice = {};
  for (const key of ['mode', 'baseUrl', 'apiKey', 'model'] as const) {
    const field = stringField(source, key);
    if (field !== undefined) choice[key] = field;
  }
  return choice;
}

function requestFromJson(body: string): AnalyzeRequest | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const source = data as Record<string, unknown>;
  const request: AnalyzeRequest = {};
  for (const key of ['packageJson', 'lockfile', 'githubUrl', 'path'] as const) {
    const field = stringField(source, key);
    if (field !== undefined) request[key] = field;
  }
  const ai = aiFromObject(source.ai);
  if (ai) request.ai = ai;
  return request;
}

function requestFromForm(body: string): { request: AnalyzeRequest; values: HomeValues } {
  const params = new URLSearchParams(body);
  const get = (name: string): string | undefined => {
    const value = params.get(name);
    return value === null || value === '' ? undefined : value;
  };
  const request: AnalyzeRequest = {};
  for (const key of ['packageJson', 'lockfile', 'githubUrl', 'path'] as const) {
    const value = get(key);
    if (value !== undefined) request[key] = value;
  }
  const ai: AiChoice = {};
  const mode = get('ai_mode');
  const baseUrl = get('ai_baseUrl');
  const apiKey = get('ai_apiKey');
  const model = get('ai_model');
  if (mode !== undefined) ai.mode = mode;
  if (baseUrl !== undefined) ai.baseUrl = baseUrl;
  if (apiKey !== undefined) ai.apiKey = apiKey;
  if (model !== undefined) ai.model = model;
  if (Object.keys(ai).length > 0) request.ai = ai;

  const values: HomeValues = {};
  const keep = { packageJson: request.packageJson, lockfile: request.lockfile, githubUrl: request.githubUrl, path: request.path, aiMode: mode, aiBaseUrl: baseUrl, aiModel: model };
  for (const [key, value] of Object.entries(keep)) {
    if (value !== undefined) (values as Record<string, string>)[key] = value;
  }
  return { request, values };
}

function mediaType(headers: Record<string, string | undefined>): string {
  return (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export function createHandler(options: HandlerOptions): Handler {
  const maxBody = options.maxBodyBytes ?? 1_500_000;
  let demoPromise: Promise<AnalysisReport> | undefined;
  const demo = (): Promise<AnalysisReport> => (demoPromise ??= options.demo());

  async function route(request: HttpRequest): Promise<{ name: string; response: HttpResponse }> {
    const { method, path } = request;
    const isApi = path.startsWith('/api/');
    const notFound = (): HttpResponse =>
      isApi ? jsonError(404, 'NOT_FOUND', 'Not found.') : html(404, renderErrorPage('Page not found', 'There is nothing at this address.'));
    const notAllowed = (allow: string): HttpResponse => {
      const extra = { allow };
      return isApi ? jsonError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', extra) : html(405, renderErrorPage('Method not allowed', 'This address does not accept that request.'), extra);
    };

    if (path === '/health') {
      return { name: 'health', response: method === 'GET' ? json(200, { status: 'ok' }) : notAllowed('GET') };
    }
    if (path === '/') {
      return {
        name: 'home',
        response: method === 'GET' ? html(200, renderHomePage({ serverAiEnabled: options.serverAiEnabled })) : notAllowed('GET'),
      };
    }
    if (path === '/demo') {
      if (method !== 'GET') return { name: 'demo', response: notAllowed('GET') };
      return { name: 'demo', response: html(200, reportHtml(await demo())) };
    }
    if (path === '/api/demo') {
      if (method !== 'GET') return { name: 'api-demo', response: notAllowed('GET') };
      return { name: 'api-demo', response: json(200, reportJson(await demo())) };
    }

    if (path === '/check' && method === 'GET') {
      return { name: 'check-form', response: html(200, renderCheckPage()) };
    }
    const known: Record<string, string> = { '/report': 'report', '/api/analyze': 'api-analyze', '/check': 'check', '/api/check': 'api-check' };
    const name = known[path];
    if (name === undefined) return { name: 'unknown', response: notFound() };
    if (method !== 'POST') return { name, response: notAllowed(path === '/check' ? 'GET, POST' : 'POST') };

    const wantsJson = path.startsWith('/api/');
    const expected = wantsJson ? 'application/json' : 'application/x-www-form-urlencoded';
    if (mediaType(request.headers) !== expected) {
      const message = `The request must use the ${expected} content type.`;
      return { name, response: wantsJson ? jsonError(415, 'UNSUPPORTED_MEDIA_TYPE', message) : html(415, renderErrorPage('Unsupported request', message)) };
    }
    if (Buffer.byteLength(request.body) > maxBody) {
      const message = 'The request is too large.';
      return { name, response: wantsJson ? jsonError(413, 'REQUEST_TOO_LARGE', message) : html(413, renderErrorPage('Request too large', message)) };
    }

    const limit = options.limiter.check(request.ip);
    if (!limit.allowed) {
      const seconds = String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000)));
      const message = 'Too many analyses from this address. Try again later.';
      return {
        name,
        response: wantsJson
          ? jsonError(429, 'RATE_LIMITED', message, { 'retry-after': seconds })
          : html(429, renderErrorPage('Too many requests', message), { 'retry-after': seconds }),
      };
    }

    if (path === '/check' || path === '/api/check') {
      let githubUrl: string | undefined;
      if (wantsJson) {
        const parsed = requestFromJson(request.body);
        if (!parsed) return { name, response: jsonError(400, 'INVALID_JSON', 'The request body must be a JSON object.') };
        githubUrl = parsed.githubUrl;
      } else {
        githubUrl = requestFromForm(request.body).request.githubUrl;
      }
      const outcome = await options.service.check(githubUrl === undefined ? {} : { githubUrl });
      if (wantsJson) {
        return { name, response: outcome.ok ? json(200, checkJson(outcome.check)) : jsonError(outcome.status, outcome.code, outcome.message) };
      }
      return {
        name,
        response: outcome.ok
          ? html(200, checkHtml(outcome.check))
          : html(outcome.status, renderCheckPage({ error: outcome.message, ...(githubUrl === undefined ? {} : { githubUrl }) })),
      };
    }

    if (wantsJson) {
      const parsed = requestFromJson(request.body);
      if (!parsed) return { name, response: jsonError(400, 'INVALID_JSON', 'The request body must be a JSON object.') };
      const outcome = await options.service.analyze(parsed);
      return {
        name,
        response: outcome.ok ? json(200, reportJson(outcome.report)) : jsonError(outcome.status, outcome.code, outcome.message),
      };
    }

    const { request: analyzeRequest, values } = requestFromForm(request.body);
    const outcome = await options.service.analyze(analyzeRequest);
    return {
      name,
      response: outcome.ok
        ? html(200, reportHtml(outcome.report))
        : html(outcome.status, renderHomePage({ serverAiEnabled: options.serverAiEnabled, error: outcome.message, values })),
    };
  }

  return async (request) => {
    const started = Date.now();
    const { name, response } = await route(request);
    options.onEvent?.({ route: name, status: response.status, durationMs: Date.now() - started });
    return response;
  };
}
