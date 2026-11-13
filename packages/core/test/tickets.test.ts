import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitTickets } from '../src/index.ts';

describe('splitTickets', () => {
  it('keeps one ticket as one block', () => {
    const result = splitTickets('Affected package: lodash\nFixed in: 4.17.21\n\nSeverity: high');
    assert.equal(result.tickets.length, 1);
    assert.equal(result.tickets[0]?.label, 'Ticket 1');
    assert.match(result.tickets[0]?.text ?? '', /Severity: high/);
  });

  it('splits on separator lines made of dashes, equals signs or stars', () => {
    const result = splitTickets('one\n---\ntwo\n=====\nthree\n***\nfour');
    assert.deepEqual(result.tickets.map((ticket) => ticket.text), ['one', 'two', 'three', 'four']);
    assert.deepEqual(result.tickets.map((ticket) => ticket.label), ['Ticket 1', 'Ticket 2', 'Ticket 3', 'Ticket 4']);
  });

  it('uses the label in a labeled separator or in a Ticket heading', () => {
    const result = splitTickets('--- SEC-101 ---\nlodash\n\n## Ticket 7\nqs\n\nIssue #12\nminimist');
    assert.deepEqual(result.tickets.map((ticket) => [ticket.label, ticket.text]), [
      ['SEC-101', 'lodash'],
      ['Ticket 7', 'qs'],
      ['Ticket 12', 'minimist'],
    ]);
  });

  it('does not split on a line that only looks like a heading inside a sentence', () => {
    const result = splitTickets('This ticket is about lodash.\nTicket ordering is not changed.');
    assert.equal(result.tickets.length, 1);
  });

  it('ignores empty blocks and Windows line endings', () => {
    const result = splitTickets('\r\n---\r\n\r\none\r\n---\r\n---\r\ntwo\r\n');
    assert.deepEqual(result.tickets.map((ticket) => ticket.text), ['one', 'two']);
  });

  it('limits the number of tickets and the length of each, and says so', () => {
    const many = Array.from({ length: 25 }, (_, index) => `package-${index}`).join('\n---\n');
    const limited = splitTickets(many);
    assert.equal(limited.tickets.length, 20);
    assert.ok(limited.warnings.some((text) => /Only the first 20 tickets/.test(text)));

    const long = splitTickets(`${'x'.repeat(30_000)}\n---\nshort`, { maxCharsPerTicket: 1000 });
    assert.equal(long.tickets[0]?.text.length, 1000);
    assert.ok(long.warnings.some((text) => /very long/.test(text)));

    const total = splitTickets('a'.repeat(300_000), { maxTotalChars: 5000, maxCharsPerTicket: 100_000 });
    assert.equal(total.tickets[0]?.text.length, 5000);
  });

  it('makes repeated labels unique', () => {
    const result = splitTickets('--- A ---\none\n--- A ---\ntwo');
    assert.deepEqual(result.tickets.map((ticket) => ticket.label), ['A', 'A (2)']);
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(splitTickets('  \n ').tickets, []);
  });
});
