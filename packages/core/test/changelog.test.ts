import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildChangelogLines,
  findSymbolMentions,
  parseVersionSections,
  sectionsBetween,
  selectForPrompt,
} from '../src/index.ts';
import { SAMPLE } from './fixtures.ts';

describe('parseVersionSections', () => {
  it('reads sections with different heading styles', () => {
    const sections = parseVersionSections(SAMPLE);
    assert.deepEqual(sections.map((section) => section.version), ['7.0.0', '7.0.0-beta.1', '6.23.0', '6.22.1']);
    assert.match(sections[0]?.body ?? '', /Removed the `json` helper/);
    assert.equal((sections[0]?.body ?? '').includes('Beta notes'), false);
  });

  it('reads underlined headings and CRLF line endings', () => {
    const text = '2.0.0\n-----\n\n* Breaking thing\n\n1.9.0\n=====\n\n* Old thing\n'.replace(/\n/g, '\r\n');
    const sections = parseVersionSections(text);
    assert.deepEqual(sections.map((section) => section.version), ['2.0.0', '1.9.0']);
  });

  it('does not treat lines inside code fences as headings', () => {
    const text = '## 2.0.0\n\n```md\n## 9.9.9\n```\n\n- Changed.\n\n## 1.0.0\n\n- First.\n';
    assert.deepEqual(parseVersionSections(text).map((section) => section.version), ['2.0.0', '1.0.0']);
  });

  it('skips sections that belong to other packages in a shared changelog', () => {
    const text = '## @scope/other@3.0.0\n\n- Other.\n\n## @scope/pkg@2.0.0\n\n- Mine.\n\n## pkg@1.0.0\n\n- Mine too.\n';
    const sections = parseVersionSections(text, '@scope/pkg');
    assert.deepEqual(sections.map((section) => section.version), ['2.0.0', '1.0.0']);
  });

  it('returns nothing for text without versions', () => {
    assert.deepEqual(parseVersionSections('# Changelog\n\nNothing here.'), []);
    assert.deepEqual(parseVersionSections(''), []);
  });
});

describe('sectionsBetween', () => {
  it('keeps versions above from and up to to, newest first, without prereleases', () => {
    const sections = parseVersionSections(SAMPLE);
    assert.deepEqual(sectionsBetween(sections, '6.22.1', '7.0.0').map((section) => section.version), ['7.0.0', '6.23.0']);
  });

  it('removes duplicate versions', () => {
    const text = '## 2.0.0\n\n- a\n\n## 2.0.0\n\n- b\n';
    assert.equal(sectionsBetween(parseVersionSections(text), '1.0.0', '2.0.0').length, 1);
  });

  it('returns nothing when no version is in range', () => {
    assert.deepEqual(sectionsBetween(parseVersionSections(SAMPLE), '7.0.0', '8.0.0'), []);
  });
});

describe('buildChangelogLines', () => {
  const sections = sectionsBetween(parseVersionSections(SAMPLE), '6.22.1', '7.0.0');
  const lines = buildChangelogLines(sections);

  it('numbers lines and keeps version headers', () => {
    assert.equal(lines[0]?.id, 'L1');
    assert.equal(lines[0]?.text, '## 7.0.0');
    assert.ok(lines.every((line, index) => line.id === `L${index + 1}`));
  });

  it('cleans links, link definitions and empty lines', () => {
    const removed = lines.find((line) => line.text.includes('Removed the'));
    assert.equal(removed?.text, '- Removed the `json` helper. Return plain objects instead. (#1234)');
    assert.equal(lines.some((line) => line.text.includes('compare/')), false);
    assert.equal(lines.some((line) => line.text === ''), false);
  });

  it('marks breaking lines by heading and by wording', () => {
    const byText = new Map(lines.map((line) => [line.text, line.breaking]));
    assert.equal(byText.get('- Removed the `json` helper. Return plain objects instead. (#1234)'), true);
    assert.equal(byText.get('- Renamed `useHistory` to `useNavigate`.'), true);
    assert.equal(byText.get('- Added `redirect` options.'), false);
    assert.equal(byText.get('- Added `createBrowserRouter` future flag.'), false);
  });

  it('strips html, images and comments', () => {
    const cleaned = buildChangelogLines([
      { version: '1.0.0', heading: '1.0.0', body: '<!-- hidden -->\n![badge](x.png) <b>Bold</b> change\n\n**Full Changelog**: https://x' },
    ]);
    assert.deepEqual(cleaned.map((line) => line.text), ['## 1.0.0', 'Bold change']);
  });
});

describe('selectForPrompt', () => {
  const sections = [
    { version: '3.0.0', heading: '3.0.0', body: '### Breaking Changes\n- Removed alpha.\n### Other\n' + '- filler line number one.\n'.repeat(40) },
  ];
  const lines = buildChangelogLines(sections);

  it('keeps everything that fits', () => {
    const selection = selectForPrompt(lines, 100_000);
    assert.equal(selection.truncated, false);
    assert.equal(selection.lines.length, lines.length);
  });

  it('prefers breaking lines when it has to cut', () => {
    const selection = selectForPrompt(lines, 200);
    assert.equal(selection.truncated, true);
    assert.ok(selection.lines.some((line) => line.text.includes('Removed alpha')));
    assert.ok(selection.lines.length < lines.length);
    const total = selection.lines.reduce((sum, line) => sum + line.text.length + line.id.length + 3, 0);
    assert.ok(total <= 200);
  });

  it('keeps the original order', () => {
    const ids = selectForPrompt(lines, 300).lines.map((line) => Number(line.id.slice(1)));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });
});

describe('findSymbolMentions', () => {
  const lines = buildChangelogLines(sectionsBetween(parseVersionSections(SAMPLE), '6.22.1', '7.0.0'));

  it('finds whole-word mentions and flags the breaking ones', () => {
    const mentions = findSymbolMentions(lines, ['json', 'redirect', 'useNavigate', 'missing']);
    assert.deepEqual(mentions.map((mention) => [mention.symbol, mention.inBreaking]), [
      ['json', true],
      ['useNavigate', true],
      ['redirect', false],
    ]);
    assert.match(mentions[0]?.excerpts[0]?.text ?? '', /Removed the `json` helper/);
  });

  it('does not match parts of longer names', () => {
    const text = [{ version: '1.0.0', heading: '1.0.0', body: '- Removed jsonStringify and my_json.' }];
    assert.deepEqual(findSymbolMentions(buildChangelogLines(text), ['json']), []);
  });

  it('ignores very short names, default and the namespace marker', () => {
    const text = [{ version: '1.0.0', heading: '1.0.0', body: '- Removed default export and a * wildcard, plus cn.' }];
    assert.deepEqual(findSymbolMentions(buildChangelogLines(text), ['cn', 'default', '*', 'a']), []);
  });

  it('handles names with regex characters', () => {
    const text = [{ version: '1.0.0', heading: '1.0.0', body: '- Removed $ref support.' }];
    assert.equal(findSymbolMentions(buildChangelogLines(text), ['$ref']).length, 1);
  });

  it('limits the excerpts per name', () => {
    const body = Array.from({ length: 10 }, (_, i) => `- Removed json variant ${i}.`).join('\n');
    const mentions = findSymbolMentions(buildChangelogLines([{ version: '1.0.0', heading: '1.0.0', body }]), ['json']);
    assert.equal(mentions[0]?.excerpts.length, 3);
  });
});
