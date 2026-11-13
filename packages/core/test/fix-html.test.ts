import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPrDescription, formatFixHtml, planMultiRemediation, planRemediation } from '../src/index.ts';
import { LOCKFILE, LODASH_TICKET, PACKAGE_JSON, QS_TICKET } from './remediate-fixtures.ts';

function single(ticket = LODASH_TICKET) {
  const result = planRemediation({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket });
  assert.ok(result.ok);
  return result;
}

describe('formatFixHtml', () => {
  const plan = single();
  const html = formatFixHtml(plan, { subject: 'demo-shop', generatedAt: '2026-11-12 10:00 UTC', homeHref: '/fix' });

  it('is a self-contained page without scripts or external requests', () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
    assert.equal(/<script|<link|<img|https?:\/\/(?!www\.w3\.org)/i.test(html.replace(/<svg[^>]*>/g, '')), false);
    assert.match(html, /prefers-color-scheme:dark/);
  });

  it('shows the headline, the diff with line numbers, the commands and the checks', () => {
    assert.match(html, /One package needs a change/);
    assert.match(html, /<tr class="remove"><td class="no">6<\/td><td class="no"><\/td><td>-    &quot;lodash&quot;: &quot;\^4\.17\.20&quot;<\/td><\/tr>/);
    assert.match(html, /<tr class="add"><td class="no"><\/td><td class="no">6<\/td><td>\+    &quot;lodash&quot;: &quot;\^4\.17\.21&quot;<\/td><\/tr>/);
    assert.match(html, /<pre class="block">npm install<\/pre>/);
    assert.match(html, /<li>npm audit<\/li>/);
    assert.match(html, /href="\/fix"/);
  });

  it('shows each finding with its severity, advisory id, options and alternatives', () => {
    assert.match(html, /<span class="badge red">high<\/span>/);
    assert.match(html, /CVE-2021-23337/);
    assert.match(html, /Raise lodash to \^4\.17\.21 <span class="badge green">recommended<\/span>/);
    assert.match(html, /Update lodash in the lockfile only <span class="badge gray">alternative<\/span>/);
    assert.match(html, /What this can and cannot do/);
    assert.match(html, /Reachability is not checked/);
  });

  it('never says that anything is fixed or safe', () => {
    assert.equal(/\bis safe\b|fixes the vulnerabilit|no longer vulnerable/i.test(html), false);
  });

  it('escapes every piece of text that came from the ticket or from package.json', () => {
    const hostile = planRemediation({
      packageJson: JSON.stringify({ name: '<img src=x onerror=alert(1)>', dependencies: { lodash: '^4.17.20' } }, null, 2),
      ticket: 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21\nSeverity: <script>alert(1)</script> high\n<script>alert(2)</script>',
    });
    assert.ok(hostile.ok);
    const page = formatFixHtml(hostile, { subject: '<b>x</b>', banner: '<i>b</i>', notes: ['<u>n</u>'] });
    assert.equal(/<script|<img|<b>|<i>|<u>/i.test(page), false);
    assert.ok(page.includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  it('says plainly when nothing needs to change', () => {
    const none = formatFixHtml(single('Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.19'));
    assert.match(none, /Nothing to change for these tickets/);
    assert.match(none, /package\.json does not change\./);
    assert.equal(none.includes('<h3>Commands</h3>'), false);
  });

  it('adds the PR and Jira descriptions when they are given, as selectable text', () => {
    const withPr = formatFixHtml(plan, { pr: { markdown: buildPrDescription(plan), jira: buildPrDescription(plan, { format: 'jira' }) } });
    assert.match(withPr, /Markdown for GitHub/);
    assert.match(withPr, /Plain text for Jira/);
    assert.match(withPr, /<pre class="block copy">Security: update lodash/);
    assert.match(withPr, /confidential/);
  });

  it('shows the matrix for several tickets', () => {
    const result = planMultiRemediation({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, tickets: [{ text: LODASH_TICKET }, { text: QS_TICKET }, { text: 'nothing here' }] });
    assert.ok(result.ok);
    const page = formatFixHtml(result);
    assert.match(page, /Which change closes which ticket/);
    assert.match(page, /Raise lodash to \^4\.17\.21/);
    assert.match(page, /Force qs to 6\.7\.3 with overrides/);
    assert.match(page, /not analyzed/);
    assert.match(page, /2 packages need a change/);
  });

  it('shows conflicts in a separate box', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { qs: '^6.0.0', host: '^1.0.0' } },
        'node_modules/qs': { version: '6.5.0' },
        'node_modules/host': { version: '1.0.0', dependencies: { qs: '6.4.0' } },
        'node_modules/host/node_modules/qs': { version: '6.4.0' },
      },
    });
    const result = planMultiRemediation({
      packageJson: JSON.stringify({ dependencies: { qs: '^6.0.0', host: '^1.0.0' } }, null, 2),
      lockfile: lock,
      tickets: [
        { text: 'Affected package: qs\nVulnerable versions: >=6.5.0 <6.5.1\nFixed in: 6.5.1\nCVE-2099-6001' },
        { text: 'Affected package: qs\nVulnerable versions: <6.5.0\nFixed in: 6.7.0\nCVE-2099-6002' },
      ],
    });
    assert.ok(result.ok);
    assert.match(formatFixHtml(result), /<p class="conflict">qs is a direct dependency and is also pulled in/);
  });
});
