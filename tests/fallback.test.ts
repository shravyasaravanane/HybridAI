import { describe, expect, it, vi } from 'vitest';
import { InferenceMode } from 'firebase/ai';
import { attemptChain, isTransient, withRetry, type ChainContext } from '../src/ai/fallback';
import { route, type RouteInput } from '../src/ai/router';

const ctx: ChainContext = { deviceReady: true, online: true, cloudEnabled: true, fitsOnDevice: true, privacyShieldEnabled: true };
const input: RouteInput = {
  routing: 'auto', online: true, device: 'available', chars: 500, maxOnDeviceChars: 12000, privateNote: false, privacyShieldEnabled: true,
};
const modes = (xs: { mode: string }[]) => xs.map((x) => x.mode);

describe('attemptChain', () => {
  it('Nano ready: on-device first, then a shielded cloud fallback', () => {
    const chain = attemptChain(route(input), ctx);
    expect(modes(chain)).toEqual([InferenceMode.ONLY_ON_DEVICE, InferenceMode.ONLY_IN_CLOUD]);
    expect(chain[0].shield).toBe(false);
    expect(chain[1].shield).toBe(true); // closes the "SDK silently goes to cloud unredacted" gap
    expect(chain[1].retry).toBe(true);
  });

  it('Nano not ready: hands off to the SDK PREFER_ON_DEVICE mode, redacted first', () => {
    const chain = attemptChain(route({ ...input, device: 'downloadable' }), { ...ctx, deviceReady: false });
    expect(modes(chain)).toEqual([InferenceMode.PREFER_ON_DEVICE]);
    expect(chain[0].shield).toBe(true);
  });

  it('long docs: cloud first; Nano fallback only if the text fits', () => {
    const d = route({ ...input, chars: 20000 });
    expect(modes(attemptChain(d, { ...ctx, fitsOnDevice: false }))).toEqual([InferenceMode.ONLY_IN_CLOUD]);
    const cloudMode = route({ ...input, routing: 'cloud' });
    expect(modes(attemptChain(cloudMode, ctx))).toEqual([InferenceMode.ONLY_IN_CLOUD, InferenceMode.ONLY_ON_DEVICE]);
  });

  it('private, offline and kill-switch requests never get a cloud attempt', () => {
    for (const d of [
      route({ ...input, privateNote: true }),
      route({ ...input, online: false }),
      route({ ...input, cloudEnabled: false }),
      route({ ...input, routing: 'cloud', cloudEnabled: false }),
    ]) {
      expect(modes(attemptChain(d, { ...ctx, cloudEnabled: false }))).toEqual([InferenceMode.ONLY_ON_DEVICE]);
    }
  });

  it('Nano ready but cloud paused: no cloud fallback leg', () => {
    expect(modes(attemptChain(route(input), { ...ctx, cloudEnabled: false }))).toEqual([InferenceMode.ONLY_ON_DEVICE]);
  });

  it('blocked decisions produce no attempts', () => {
    expect(attemptChain(route({ ...input, privateNote: true, device: 'unavailable' }), { ...ctx, deviceReady: false })).toEqual([]);
  });
});

describe('isTransient', () => {
  it('retries rate limits, 5xx and network errors', () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ customErrorData: { status: 503 } })).toBe(true);
    expect(isTransient(new Error('[503 Service Unavailable] UNAVAILABLE'))).toBe(true);
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransient(new Error('RESOURCE_EXHAUSTED: quota'))).toBe(true);
  });

  it('does not retry App Check, config or safety errors', () => {
    expect(isTransient(new Error('[403] PERMISSION_DENIED app-check token invalid'))).toBe(false);
    expect(isTransient(new Error('API_NOT_ENABLED'))).toBe(false);
    expect(isTransient(new Error('Response was blocked due to SAFETY'))).toBe(false);
  });
});

describe('withRetry', () => {
  const sleep = vi.fn(async () => {});

  it('retries transient errors with backoff, then succeeds', async () => {
    let n = 0;
    const onRetry = vi.fn();
    const out = await withRetry(async () => {
      if (n++ < 2) throw new Error('503 UNAVAILABLE');
      return 'ok';
    }, { sleep, onRetry, baseMs: 100 });
    expect(out).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([100, 300]);
  });

  it('gives up after the retry budget', async () => {
    await expect(withRetry(async () => { throw new Error('429'); }, { sleep, retries: 1 })).rejects.toThrow('429');
  });

  it('does not retry permanent errors', async () => {
    const fn = vi.fn(async () => { throw new Error('403 PERMISSION_DENIED'); });
    await expect(withRetry(fn, { sleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
