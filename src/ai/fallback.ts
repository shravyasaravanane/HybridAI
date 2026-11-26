/**
 * Fallback chain: turns a routing decision into an ordered list of attempts,
 * plus the retry helper used for cloud attempts.
 *
 * Why not just rely on the SDK's PREFER_ON_DEVICE fallback everywhere?
 *  1. The SDK only falls back when Gemini Nano is *unavailable*. If the
 *     on-device call itself throws (session error, prompt too large), the
 *     error reaches the user with no cloud retry.
 *  2. When the SDK falls back on its own, our Privacy Shield has not run,
 *     so the note would leave the device unredacted.
 * So when Nano is ready we run the on-device leg as ONLY_ON_DEVICE and make
 * the cloud leg an explicit, shielded second attempt. When Nano is not ready
 * we still hand the request to the SDK's PREFER_ON_DEVICE mode (it re-checks
 * availability itself), but redact first because it will most likely go to
 * the cloud.
 *
 * Pure (no Firebase / DOM access), unit-tested in tests/fallback.test.ts.
 */
import { InferenceMode } from 'firebase/ai';
import type { RouteDecision } from './router';

export interface Attempt {
  mode: InferenceMode;
  expected: 'on_device' | 'in_cloud';
  /** Redact personal data before this attempt (it may reach the cloud). */
  shield: boolean;
  /** Retry transient errors (network, 429, 5xx); only cloud attempts. */
  retry: boolean;
  label: string;
}

export interface ChainContext {
  deviceReady: boolean;
  online: boolean;
  /** Remote Config kill-switch. */
  cloudEnabled: boolean;
  fitsOnDevice: boolean;
  privacyShieldEnabled: boolean;
}

const nano = (label = 'Gemini Nano'): Attempt => ({
  mode: InferenceMode.ONLY_ON_DEVICE,
  expected: 'on_device',
  shield: false,
  retry: false,
  label,
});

export function attemptChain(d: RouteDecision, c: ChainContext): Attempt[] {
  if (d.blocked) return [];
  const cloudOk = c.online && c.cloudEnabled;
  const cloud = (label: string): Attempt => ({
    mode: InferenceMode.ONLY_IN_CLOUD,
    expected: 'in_cloud',
    shield: c.privacyShieldEnabled,
    retry: true,
    label,
  });

  switch (d.mode) {
    case InferenceMode.ONLY_ON_DEVICE:
      // Private note / Local mode / offline / cloud paused: policy says never the cloud.
      return [nano()];

    case InferenceMode.PREFER_ON_DEVICE:
      if (c.deviceReady) {
        return cloudOk ? [nano(), cloud('Cloud fallback')] : [nano()];
      }
      return [
        {
          mode: InferenceMode.PREFER_ON_DEVICE,
          expected: 'in_cloud',
          shield: c.privacyShieldEnabled,
          retry: true,
          label: 'Hybrid SDK (cloud fallback)',
        },
      ];

    case InferenceMode.ONLY_IN_CLOUD: {
      if (!cloudOk) return c.deviceReady && c.fitsOnDevice ? [nano()] : [];
      const chain = [cloud('Cloud')];
      // If the cloud is down or out of quota, Gemini Nano can still answer a text that fits.
      if (c.deviceReady && c.fitsOnDevice) chain.push(nano('On-device fallback'));
      return chain;
    }

    default:
      return [];
  }
}

/** Errors worth retrying: rate limits, server hiccups, flaky network. Not App Check / config / safety errors. */
export function isTransient(err: unknown): boolean {
  const e = err as { message?: string; code?: string; status?: number; customErrorData?: { status?: number } };
  const status = e?.status ?? e?.customErrorData?.status;
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  const text = `${e?.code ?? ''} ${e?.message ?? String(err)}`;
  if (/\b(403|401|400)\b|PERMISSION_DENIED|app-check|API_NOT_ENABLED|SAFETY|blocked/i.test(text)) return false;
  return /\b(408|429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|fetch-error|Failed to fetch|NetworkError|network|timed? ?out/i.test(text);
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Exponential backoff (base, 3x base, …) for transient errors only. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseMs = 600, onRetry, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= retries || !isTransient(err)) throw err;
      onRetry?.(i + 1, err);
      await sleep(baseMs * 3 ** i);
    }
  }
}

/** Thrown when every attempt in the chain failed; carries each attempt's error for the UI. */
export class AllAttemptsFailed extends Error {
  constructor(readonly failures: { label: string; error: unknown }[]) {
    super(failures.map((f) => `${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`).join(' | '));
    this.name = 'AllAttemptsFailed';
  }
}
