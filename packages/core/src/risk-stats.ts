import { getText } from './http.ts';
import type { RiskReport } from './risk-types.ts';
import { summarizeSignals } from './risk-assess.ts';
import { isPlainObject, mapWithConcurrency } from './util.ts';

export interface StatsSource {
  weeklyDownloads(name: string): Promise<number | undefined>;
}

export interface NpmStatsOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createNpmStatsSource(options: NpmStatsOptions = {}): StatsSource {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async weeklyDownloads(name) {
      const url = `https://api.npmjs.org/downloads/point/last-week/${name.replace('/', '%2F')}`;
      const result = await getText(url, {
        fetch: doFetch,
        allowedHosts: ['api.npmjs.org'],
        timeoutMs: options.timeoutMs ?? 8_000,
        maxChars: 20_000,
      });
      if (!result.ok) return undefined;
      try {
        const data: unknown = JSON.parse(result.text);
        return isPlainObject(data) && typeof data.downloads === 'number' ? data.downloads : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export interface RefineOptions {
  maxLookups?: number;
}

export async function refineLookalikes(report: RiskReport, source: StatsSource, options: RefineOptions = {}): Promise<void> {
  const targets = report.signals.filter((signal) => signal.id === 'dependency-lookalike' && signal.subject !== undefined);
  const limited = targets.slice(0, options.maxLookups ?? 10);
  await mapWithConcurrency(limited, 4, async (signal) => {
    let downloads: number | undefined;
    try {
      downloads = await source.weeklyDownloads(signal.subject as string);
    } catch {
      downloads = undefined;
    }
    if (downloads === undefined) return;
    if (downloads < 500) {
      signal.severity = 'high';
      signal.confidence = 'medium';
      signal.detail += ` It has only ${downloads} downloads last week, which is very few for a name this close to a popular package.`;
    } else if (downloads >= 50_000) {
      signal.severity = 'info';
      signal.confidence = 'medium';
      signal.detail += ` It has ${downloads} downloads last week, so it is probably a legitimate package of its own.`;
    } else {
      signal.detail += ` It has ${downloads} downloads last week.`;
    }
  });
  summarizeSignals(report);
}
