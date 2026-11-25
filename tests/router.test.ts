import { describe, expect, it } from 'vitest';
import { InferenceMode } from 'firebase/ai';
import { route, type RouteInput } from '../src/ai/router';

const base: RouteInput = {
  routing: 'auto',
  online: true,
  device: 'available',
  chars: 1000,
  maxOnDeviceChars: 12000,
  privateNote: false,
  privacyShieldEnabled: true,
};

describe('Smart Router', () => {
  it('prefers on-device for short notes when Gemini Nano is ready', () => {
    const d = route(base);
    expect(d.mode).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(d.expected).toBe('on_device');
    expect(d.shield).toBe(false);
    expect(d.blocked).toBeUndefined();
  });

  it('sends long documents to the cloud with the Privacy Shield', () => {
    const d = route({ ...base, chars: 20000 });
    expect(d.mode).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(d.expected).toBe('in_cloud');
    expect(d.shield).toBe(true);
  });

  it('lets the SDK fall back to the cloud (shielded) when there is no local model', () => {
    const d = route({ ...base, device: 'unavailable' });
    expect(d.mode).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(d.expected).toBe('in_cloud');
    expect(d.shield).toBe(true);
  });

  it('respects Remote Config disabling the shield', () => {
    expect(route({ ...base, routing: 'cloud', privacyShieldEnabled: false }).shield).toBe(false);
  });

  it('forces on-device when offline and blocks if no model', () => {
    expect(route({ ...base, online: false }).mode).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(route({ ...base, online: false, device: 'unavailable' }).blocked).toMatch(/Offline/);
  });

  it('never routes device-only notes to the cloud, even in cloud mode', () => {
    const d = route({ ...base, routing: 'cloud', privateNote: true });
    expect(d.mode).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(d.expected).toBe('on_device');
    expect(route({ ...base, privateNote: true, device: 'downloadable' }).blocked).toMatch(/Get Gemini Nano/);
    expect(route({ ...base, privateNote: true, chars: 50000 }).blocked).toMatch(/budget/);
  });

  it('local mode uses ONLY_ON_DEVICE and cloud mode uses ONLY_IN_CLOUD', () => {
    expect(route({ ...base, routing: 'local' }).mode).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(route({ ...base, routing: 'cloud' }).mode).toBe(InferenceMode.ONLY_IN_CLOUD);
  });
});
