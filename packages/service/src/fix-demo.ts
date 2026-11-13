import { buildPrDescription, planMultiRemediation, splitTickets } from '@dependency-radar/core';
import type { MultiRemediationPlan } from '@dependency-radar/core';
import type { FixReport } from './service.ts';

export const DEMO_FIX_PACKAGE_JSON = JSON.stringify(
  {
    name: 'demo-shop',
    version: '1.0.0',
    dependencies: { express: '^4.17.1', lodash: '^4.17.20' },
    devDependencies: { 'demo-runner': '^3.0.0' },
  },
  null,
  2,
) + '\n';

export const DEMO_FIX_LOCKFILE = JSON.stringify({
  name: 'demo-shop',
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo-shop', dependencies: { express: '^4.17.1', lodash: '^4.17.20' }, devDependencies: { 'demo-runner': '^3.0.0' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/demo-runner': { version: '3.0.0', dev: true, dependencies: { minimist: '^1.2.0' } },
    'node_modules/minimist': { version: '1.2.5', dev: true },
  },
});

export const DEMO_FIX_TICKETS = `Affected package: lodash
Installed version: 4.17.20
Fixed in: 4.17.21
Severity: high
CVE-2021-23337

---

Affected package: qs
Vulnerable versions: <6.7.3
Fixed in: 6.7.3
Severity: high
GHSA-hrpp-h998-j3pp

---

Affected package: minimist
Vulnerable versions: <1.2.6
Fixed in: 1.2.6
Severity: critical
CVE-2021-44906`;

export function buildFixDemo(now: Date = new Date()): FixReport {
  const split = splitTickets(DEMO_FIX_TICKETS);
  const plan = planMultiRemediation({ packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE, tickets: split.tickets });
  if (!plan.ok) throw new Error('The sample ticket could not be planned.');
  const multi: MultiRemediationPlan = plan;
  return {
    source: 'demo',
    subject: 'demo-shop (sample data)',
    generatedAt: now.toISOString(),
    plan: multi,
    pr: { markdown: buildPrDescription(multi), jira: buildPrDescription(multi, { format: 'jira' }) },
    notes: ['Your code was not scanned in this sample.'],
    majorChecks: [],
    scanned: false,
  };
}
