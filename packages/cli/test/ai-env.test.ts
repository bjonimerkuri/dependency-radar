import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAiFromEnv } from '../src/ai-env.ts';

const full = { RADAR_AI_BASE_URL: 'https://api.groq.com/openai/v1', RADAR_AI_KEY: 'secret', RADAR_AI_MODEL: 'm' };

describe('createAiFromEnv', () => {
  it('returns nothing when no AI variables are set', () => {
    assert.deepEqual(createAiFromEnv({}), {});
    assert.deepEqual(createAiFromEnv({ RADAR_AI_KEY: '  ' }), {});
  });

  it('creates a provider when all three are set', () => {
    const result = createAiFromEnv(full);
    assert.equal(result.error, undefined);
    assert.ok(result.provider);
  });

  it('asks for all three when only some are set', () => {
    const result = createAiFromEnv({ RADAR_AI_KEY: 'secret' });
    assert.match(result.error ?? '', /RADAR_AI_BASE_URL, RADAR_AI_KEY and RADAR_AI_MODEL together/);
    assert.equal(result.provider, undefined);
  });

  it('rejects hosts that are not allowed without echoing the key', () => {
    const result = createAiFromEnv({ ...full, RADAR_AI_BASE_URL: 'https://evil.example.com/v1' });
    assert.match(result.error ?? '', /must be an https address/);
    assert.equal((result.error ?? '').includes('secret'), false);
  });

  it('rejects an address that is not a URL', () => {
    assert.ok(createAiFromEnv({ ...full, RADAR_AI_BASE_URL: 'not a url' }).error);
  });
});
