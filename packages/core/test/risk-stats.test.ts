import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessRepository, createNpmStatsSource, refineLookalikes } from '../src/index.ts';
import type { StatsSource } from '../src/index.ts';

function report() {
  const dependencies = { crossenv: '1.0.0', lodahs: '1.0.0', expres: '1.0.0', axois: '1.0.0' };
  return assessRepository({ files: [{ path: 'package.json', content: JSON.stringify({ dependencies }) }] });
}

const source = (counts: Record<string, number | undefined>, asked: string[] = []): StatsSource => ({
  async weeklyDownloads(name) {
    asked.push(name);
    return counts[name];
  },
});

describe('refineLookalikes', () => {
  it('raises names with very few downloads, lowers popular ones and leaves the rest', async () => {
    const result = report();
    await refineLookalikes(result, source({ crossenv: 12, lodahs: 80_000, expres: 5_000, axois: undefined }));
    const bySubject = new Map(result.signals.map((signal) => [signal.subject, signal]));
    assert.equal(bySubject.get('crossenv')?.severity, 'high');
    assert.match(bySubject.get('crossenv')?.detail ?? '', /only 12 downloads/);
    assert.equal(bySubject.get('lodahs')?.severity, 'info');
    assert.match(bySubject.get('lodahs')?.detail ?? '', /probably a legitimate package/);
    assert.equal(bySubject.get('expres')?.severity, 'low');
    assert.match(bySubject.get('expres')?.detail ?? '', /5000 downloads/);
    assert.equal(bySubject.get('axois')?.severity, 'low');
  });

  it('re-sorts the signals and updates the highest severity', async () => {
    const result = report();
    assert.equal(result.highest, 'medium');
    await refineLookalikes(result, source({ lodahs: 10 }));
    assert.equal(result.highest, 'high');
    assert.equal(result.signals[0]?.subject, 'lodahs');
  });

  it('can lower the highest severity too', async () => {
    const result = assessRepository({ files: [{ path: 'package.json', content: JSON.stringify({ dependencies: { crossenv: '1.0.0' } }) }] });
    await refineLookalikes(result, source({ crossenv: 900_000 }));
    assert.equal(result.highest, 'info');
  });

  it('limits the number of lookups and survives failures', async () => {
    const asked: string[] = [];
    await refineLookalikes(report(), source({}, asked), { maxLookups: 2 });
    assert.equal(asked.length, 2);

    const failing: StatsSource = { async weeklyDownloads() { throw new Error('down'); } };
    const result = report();
    await refineLookalikes(result, failing);
    assert.equal(result.signals.length, 4);
  });
});

describe('createNpmStatsSource', () => {
  const respond = (status: number, body: unknown, seen: string[] = []) =>
    (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it('reads the weekly downloads and encodes scoped names', async () => {
    const seen: string[] = [];
    const stats = createNpmStatsSource({ fetch: respond(200, { downloads: 1234, package: 'x' }, seen) });
    assert.equal(await stats.weeklyDownloads('@scope/pkg'), 1234);
    assert.deepEqual(seen, ['https://api.npmjs.org/downloads/point/last-week/@scope%2Fpkg']);
  });

  it('returns nothing on errors and odd answers', async () => {
    for (const fetchImpl of [respond(404, {}), respond(500, {}), respond(200, 'nope'), respond(200, { downloads: 'many' }), respond(200, [])]) {
      assert.equal(await createNpmStatsSource({ fetch: fetchImpl }).weeklyDownloads('x'), undefined);
    }
  });
});
