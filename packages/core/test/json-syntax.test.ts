import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findJsonSyntaxError } from '../src/index.ts';

describe('findJsonSyntaxError', () => {
  it('accepts valid JSON', () => {
    assert.equal(findJsonSyntaxError('{"a":[1,2.5e3,true,false,null,"x\\n\\u0041"]}'), undefined);
  });

  it('finds a trailing comma in an object', () => {
    assert.equal(findJsonSyntaxError('{"a":1,}')?.index, 7);
  });

  it('finds a missing value', () => {
    assert.equal(findJsonSyntaxError('{"a":}')?.index, 5);
  });

  it('finds single quotes', () => {
    assert.equal(findJsonSyntaxError(`{"a": 'x'}`)?.index, 6);
  });

  it('finds content after the value', () => {
    assert.equal(findJsonSyntaxError('{"a":1} x')?.index, 8);
  });

  it('reports an unexpected end', () => {
    const issue = findJsonSyntaxError('[1,2');
    assert.equal(issue?.index, 4);
    assert.match(issue?.message ?? '', /end of input/);
  });

  it('reports an unterminated string at its start', () => {
    assert.equal(findJsonSyntaxError('{"a":"b')?.index, 5);
  });

  it('reports an invalid escape', () => {
    assert.ok(findJsonSyntaxError('{"a":"\\q"}'));
  });

  it('rejects an empty document', () => {
    assert.equal(findJsonSyntaxError('')?.index, 0);
  });
});
