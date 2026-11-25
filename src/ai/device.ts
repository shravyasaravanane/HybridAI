/**
 * On-device model (Gemini Nano via Chrome's built-in Prompt API) status helpers.
 * The actual inference always goes through Firebase AI Logic; this module only
 * reports availability for the UI and the router, and triggers the download.
 */
import type { GenerativeModel } from 'firebase/ai';
import type { DeviceStatus } from './router';

interface LanguageModelStatic {
  availability(options?: unknown): Promise<string>;
}

/** Same expectations the Firebase AI Logic Chrome adapter uses by default (English text). */
const PROBE_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function languageModel(): LanguageModelStatic | undefined {
  return (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

export async function probeDevice(): Promise<DeviceStatus> {
  const lm = languageModel();
  if (!lm) return 'unavailable';
  try {
    const a = await Promise.race([
      lm.availability(PROBE_OPTIONS),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    if (a === 'available' || a === 'downloadable' || a === 'downloading' || a === 'unavailable') return a;
    // Older Chrome builds used "readily" / "after-download".
    if (a === 'readily') return 'available';
    if (a === 'after-download') return 'downloadable';
    return 'unknown';
  } catch {
    return 'unavailable';
  }
}

/**
 * Starts the Gemini Nano download through Firebase AI Logic.
 * Must be called from a user gesture (click), per the Prompt API rules.
 * Resolves once the model reports "available" (or rejects on failure).
 */
export async function downloadDeviceModel(
  model: GenerativeModel,
  onProgress: (fraction: number) => void,
): Promise<DeviceStatus> {
  await model.initializeDeviceModel((p) => onProgress(p));
  // initializeDeviceModel kicks the download off in the background; poll until it lands.
  for (let i = 0; i < 1800; i++) {
    const s = await probeDevice();
    if (s === 'available' || s === 'unavailable') return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return probeDevice();
}

export function describeDevice(s: DeviceStatus): string {
  switch (s) {
    case 'available':
      return 'Gemini Nano ready';
    case 'downloadable':
      return 'Gemini Nano not downloaded';
    case 'downloading':
      return 'Downloading Gemini Nano';
    case 'unavailable':
      return 'No on-device model';
    default:
      return 'Checking on-device model';
  }
}
