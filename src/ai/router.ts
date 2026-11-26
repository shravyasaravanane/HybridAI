/**
 * Smart Router: decides, per request, which Firebase AI Logic InferenceMode to use
 * and whether the Privacy Shield must run before text can leave the device.
 *
 * Pure function: no Firebase or DOM access, so it is fully unit-tested.
 */
import { InferenceMode } from 'firebase/ai';

export type Routing = 'auto' | 'local' | 'cloud';
export type DeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown';

export interface RouteInput {
  routing: Routing;
  online: boolean;
  device: DeviceStatus;
  /** Length of the text that will be sent to the model. */
  chars: number;
  /** Remote Config: Gemini Nano context budget expressed in characters. */
  maxOnDeviceChars: number;
  /** Device-only notes must never be sent to the cloud. */
  privateNote: boolean;
  /** Remote Config: redact personal data before cloud calls. */
  privacyShieldEnabled: boolean;
  /** Remote Config kill-switch. When false, every request must run on-device. Defaults to true. */
  cloudEnabled?: boolean;
}

export interface RouteDecision {
  mode: InferenceMode;
  /** Where we expect the request to run (the SDK reports the real source afterwards). */
  expected: 'on_device' | 'in_cloud';
  /** Short, human-readable reason shown in the UI and stored in the ledger. */
  reason: string;
  /** Redact personal data before the prompt is sent (only relevant when it may reach the cloud). */
  shield: boolean;
  /** If set, the request cannot run at all; the string explains why. */
  blocked?: string;
}

const deviceReady = (d: DeviceStatus) => d === 'available';

export function route(input: RouteInput): RouteDecision {
  const { routing, online, device, chars, maxOnDeviceChars, privateNote, privacyShieldEnabled } = input;
  const fits = chars <= maxOnDeviceChars;
  const onlyDevice = (reason: string): RouteDecision => {
    if (!deviceReady(device)) {
      return {
        mode: InferenceMode.ONLY_ON_DEVICE,
        expected: 'on_device',
        reason,
        shield: false,
        blocked:
          device === 'downloadable' || device === 'downloading'
            ? `${reason}. Gemini Nano is not downloaded yet, so tap "Get Gemini Nano" first.`
            : `${reason}. This browser has no on-device model (needs Chrome 139+ with the Prompt API enabled).`,
      };
    }
    if (!fits) {
      return {
        mode: InferenceMode.ONLY_ON_DEVICE,
        expected: 'on_device',
        reason,
        shield: false,
        blocked: `${reason}, but this text (${fmt(chars)} chars) exceeds Gemini Nano's ${fmt(maxOnDeviceChars)}-char budget. Shorten it or select a passage.`,
      };
    }
    return { mode: InferenceMode.ONLY_ON_DEVICE, expected: 'on_device', reason, shield: false };
  };

  if (privateNote) return onlyDevice('Device-only note: stays on this device');
  if (routing === 'local') return onlyDevice('Local-only mode');
  if (!online) return onlyDevice('Offline: using on-device Gemini Nano');
  if (input.cloudEnabled === false) return onlyDevice('Cloud AI is paused by the admin (Remote Config)');

  if (routing === 'cloud') {
    return {
      mode: InferenceMode.ONLY_IN_CLOUD,
      expected: 'in_cloud',
      reason: 'Cloud-only mode',
      shield: privacyShieldEnabled,
    };
  }

  // auto (hybrid)
  if (!fits) {
    return {
      mode: InferenceMode.ONLY_IN_CLOUD,
      expected: 'in_cloud',
      reason: `Long text (${fmt(chars)} > ${fmt(maxOnDeviceChars)} chars) goes to the cloud model`,
      shield: privacyShieldEnabled,
    };
  }
  if (deviceReady(device)) {
    return {
      mode: InferenceMode.PREFER_ON_DEVICE,
      expected: 'on_device',
      reason: 'Fits on-device and Gemini Nano is ready',
      shield: false,
    };
  }
  return {
    mode: InferenceMode.PREFER_ON_DEVICE,
    expected: 'in_cloud',
    reason:
      device === 'downloadable' || device === 'downloading'
        ? 'Gemini Nano not downloaded yet, so the SDK falls back to the cloud'
        : device === 'unknown'
          ? 'On-device model status unknown, so the SDK checks and may fall back to the cloud'
          : 'No on-device model in this browser, so the SDK falls back to the cloud',
    shield: privacyShieldEnabled,
  };
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
