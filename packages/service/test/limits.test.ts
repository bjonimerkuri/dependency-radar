import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDailyBudget, createRateLimiter } from '../src/limits.ts';

describe('createRateLimiter', () => {
  it('allows up to the limit per key and then blocks with a retry time', () => {
    let clock = 1000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
    assert.deepEqual(limiter.check('a'), { allowed: true, remaining: 1, retryAfterMs: 0 });
    assert.deepEqual(limiter.check('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
    clock = 11_000;
    assert.deepEqual(limiter.check('a'), { allowed: false, remaining: 0, retryAfterMs: 50_000 });
    assert.equal(limiter.check('b').allowed, true);
  });

  it('starts a new window after the old one ends', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => clock });
    limiter.check('a');
    assert.equal(limiter.check('a').allowed, false);
    clock = 100;
    assert.equal(limiter.check('a').allowed, true);
  });

  it('keeps its memory bounded', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000_000, maxKeys: 5 });
    for (let i = 0; i < 100; i++) limiter.check(`key-${i}`);
    assert.equal(limiter.check('key-99').allowed, false);
    assert.equal(limiter.check('key-0').allowed, true);
  });
});

describe('createDailyBudget', () => {
  it('counts down and resets on the next UTC day', () => {
    let clock = Date.parse('2026-10-29T23:59:00Z');
    const budget = createDailyBudget({ limit: 2, now: () => clock });
    assert.equal(budget.remaining(), 2);
    assert.equal(budget.tryConsume(), true);
    assert.equal(budget.tryConsume(), true);
    assert.equal(budget.tryConsume(), false);
    assert.equal(budget.remaining(), 0);
    clock = Date.parse('2026-10-30T00:01:00Z');
    assert.equal(budget.remaining(), 2);
    assert.equal(budget.tryConsume(), true);
  });
});
