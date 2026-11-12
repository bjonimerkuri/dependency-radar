export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  function prune(): void {
    const current = now();
    for (const [key, window] of windows) {
      if (window.resetAt <= current) windows.delete(key);
    }
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  }

  return {
    check(key) {
      const current = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= current) {
        if (!window && windows.size >= maxKeys) prune();
        window = { count: 0, resetAt: current + options.windowMs };
        windows.set(key, window);
      }
      if (window.count >= options.limit) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, window.resetAt - current) };
      }
      window.count++;
      return { allowed: true, remaining: options.limit - window.count, retryAfterMs: 0 };
    },
  };
}

export interface DailyBudget {
  tryConsume(): boolean;
  remaining(): number;
}

export interface DailyBudgetOptions {
  limit: number;
  now?: () => number;
}

export function createDailyBudget(options: DailyBudgetOptions): DailyBudget {
  const now = options.now ?? Date.now;
  let day = new Date(now()).toISOString().slice(0, 10);
  let used = 0;

  function rollOver(): void {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  return {
    tryConsume() {
      rollOver();
      if (used >= options.limit) return false;
      used++;
      return true;
    },
    remaining() {
      rollOver();
      return Math.max(0, options.limit - used);
    },
  };
}
