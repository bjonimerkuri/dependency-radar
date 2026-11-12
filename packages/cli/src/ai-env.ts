import { createOpenAiCompatibleProvider, KNOWN_AI_HOSTS } from '@dependency-radar/core';
import type { AiProvider } from '@dependency-radar/core';

export interface AiFromEnv {
  provider?: AiProvider;
  error?: string;
}

export function createAiFromEnv(env: Readonly<Record<string, string | undefined>>): AiFromEnv {
  const baseUrl = env.RADAR_AI_BASE_URL?.trim();
  const apiKey = env.RADAR_AI_KEY?.trim();
  const model = env.RADAR_AI_MODEL?.trim();
  const present = [baseUrl, apiKey, model].filter((value) => value !== undefined && value !== '').length;

  if (present === 0) return {};
  if (present < 3 || !baseUrl || !apiKey || !model) {
    return { error: 'To use AI explanations, set RADAR_AI_BASE_URL, RADAR_AI_KEY and RADAR_AI_MODEL together.' };
  }
  try {
    return { provider: createOpenAiCompatibleProvider({ baseUrl, apiKey, model }) };
  } catch {
    return { error: `RADAR_AI_BASE_URL must be an https address on one of: ${KNOWN_AI_HOSTS.join(', ')}.` };
  }
}
