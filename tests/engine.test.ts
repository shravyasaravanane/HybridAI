/**
 * HybridEngine fallback behaviour with fake models (no Firebase, no network).
 * The fake factory receives the real HybridParams the engine would pass to
 * getGenerativeModel, so these tests also check which InferenceMode is used.
 */
import { describe, expect, it } from 'vitest';
import { InferenceMode, type HybridParams } from 'firebase/ai';
import { HybridEngine, friendlyError, type ModelLike } from '../src/ai/engine';
import { AllAttemptsFailed } from '../src/ai/fallback';
import { ENTITY_SCHEMA } from '../src/ai/privacy';
import { route } from '../src/ai/router';
import { RC_DEFAULTS, type AppConfig } from '../src/firebase';

const config: AppConfig = {
  cloudModel: 'test-cloud-model',
  onDeviceMaxChars: 12000,
  privacyShieldEnabled: true,
  shieldMaxChunks: 4,
  defaultRouting: 'auto',
  announcement: '',
  cloudEnabled: RC_DEFAULTS.cloud_enabled,
  promptTemplates: {},
};

type Behavior = (prompt: string) => string | Error | { failAfter: string };
interface Calls { mode: InferenceMode; prompt: string }

function fakeFactory(behaviors: Partial<Record<InferenceMode, Behavior[]>>, calls: Calls[]) {
  const counters = new Map<string, number>();
  return (params: HybridParams): ModelLike => {
    const isEntity = params.onDeviceParams?.promptOptions?.responseConstraint === ENTITY_SCHEMA;
    const source = params.mode === InferenceMode.ONLY_IN_CLOUD ? 'in_cloud' : 'on_device';
    const next = (prompt: string) => {
      calls.push({ mode: params.mode, prompt });
      const list = behaviors[params.mode] ?? [];
      const n = counters.get(params.mode) ?? 0;
      counters.set(params.mode, n + 1);
      return (list[Math.min(n, list.length - 1)] ?? (() => new Error('no behavior')))(prompt);
    };
    const response = (text: string) => ({ text: () => text, inferenceSource: source });
    return {
      initializeDeviceModel: async () => {},
      generateContent: (async (prompt: string) => {
        if (isEntity) {
          calls.push({ mode: params.mode, prompt: '[entity-scan]' });
          return { response: response(JSON.stringify({ entities: [{ text: 'Priya Sharma', type: 'PERSON' }] })) };
        }
        const out = next(prompt);
        if (out instanceof Error) throw out;
        return { response: response(typeof out === 'string' ? out : out.failAfter) };
      }) as unknown as ModelLike['generateContent'],
      generateContentStream: (async (prompt: string) => {
        const out = next(prompt);
        if (out instanceof Error) throw out;
        const plan = out; // narrowed copy: TS drops narrowing inside the nested generator
        async function* stream() {
          if (typeof plan === 'string') {
            for (const piece of plan.match(/.{1,7}/gs) ?? []) yield response(piece);
          } else {
            yield response(plan.failAfter);
            throw new Error('Gemini Nano session crashed mid-stream');
          }
        }
        const s = stream();
        return { stream: s, response: Promise.resolve(response('')) };
      }) as unknown as ModelLike['generateContentStream'],
    };
  };
}

const NOTE = { title: 'Call', body: 'Call Priya Sharma at priya@x.example about the demo.' };
const base = { routing: 'auto' as const, online: true, device: 'available' as const, chars: 60, maxOnDeviceChars: 12000, privateNote: false, privacyShieldEnabled: true };
const ctx = { deviceReady: true, online: true, cloudEnabled: true, fitsOnDevice: true, privacyShieldEnabled: true };

describe('HybridEngine fallback', () => {
  it('Gemini Nano fails mid-stream: discards partial text and retries in the cloud, redacted', async () => {
    const calls: Calls[] = [];
    const texts: string[] = [];
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_ON_DEVICE]: [() => ({ failAfter: '- partial' })],
      [InferenceMode.ONLY_IN_CLOUD]: [() => '- Follow up with [PERSON_1] at [EMAIL_1]'],
    }, calls));

    const r = await engine.run({ task: 'summarize', args: NOTE, decision: route(base), context: ctx, onText: (t) => texts.push(t) });

    expect(r.source).toBe('in_cloud');
    expect(r.fellBack).toBe(true);
    expect(r.attempts.map((a) => [a.label, a.ok])).toEqual([['Gemini Nano', false], ['Cloud fallback', true]]);
    // The cloud never saw personal data...
    const cloudPrompt = calls.find((c) => c.mode === InferenceMode.ONLY_IN_CLOUD)!.prompt;
    expect(cloudPrompt).not.toContain('Priya');
    expect(cloudPrompt).not.toContain('priya@x.example');
    expect(cloudPrompt).toContain('[PERSON_1]');
    // ...but the user sees it restored, and the partial on-device text was cleared.
    expect(r.text).toBe('- Follow up with Priya Sharma at priya@x.example');
    expect(texts).toContain('');
  });

  it('retries a transient cloud error and reports the retry', async () => {
    const calls: Calls[] = [];
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_IN_CLOUD]: [() => new Error('[503] UNAVAILABLE'), () => '- ok'],
    }, calls));
    const r = await engine.run({ task: 'summarize', args: NOTE, decision: route({ ...base, routing: 'cloud' }), context: { ...ctx, deviceReady: false } });
    expect(r.text).toBe('- ok');
    expect(r.attempts[0].retries).toBe(1);
    expect(r.fellBack).toBe(false);
  });

  it('cloud fails permanently: falls back to Gemini Nano when the text fits', async () => {
    const calls: Calls[] = [];
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_IN_CLOUD]: [() => new Error('[403] PERMISSION_DENIED app-check')],
      [InferenceMode.ONLY_ON_DEVICE]: [() => '- local answer'],
    }, calls));
    const r = await engine.run({ task: 'summarize', args: NOTE, decision: route({ ...base, routing: 'cloud' }), context: ctx });
    expect(r.source).toBe('on_device');
    expect(r.text).toBe('- local answer');
    expect(r.attempts[0].error).toMatch(/App Check/);
    // Permanent errors are not retried.
    expect(calls.filter((c) => c.mode === InferenceMode.ONLY_IN_CLOUD)).toHaveLength(1);
  });

  it('malformed JSON from Gemini Nano falls back to the cloud for structured tasks', async () => {
    const calls: Calls[] = [];
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_ON_DEVICE]: [() => 'not json at all'],
      [InferenceMode.ONLY_IN_CLOUD]: [() => '{"items":[{"task":"Email [PERSON_1]"}]}'],
    }, calls));
    const r = await engine.run({ task: 'actions', args: NOTE, decision: route(base), context: ctx });
    expect(r.fellBack).toBe(true);
    expect(r.data).toEqual({ items: [{ task: 'Email Priya Sharma' }] });
  });

  it('device-only notes never fall back to the cloud', async () => {
    const calls: Calls[] = [];
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_ON_DEVICE]: [() => new Error('Nano unavailable')],
      [InferenceMode.ONLY_IN_CLOUD]: [() => 'should never run'],
    }, calls));
    await expect(engine.run({ task: 'summarize', args: NOTE, decision: route({ ...base, privateNote: true }), context: ctx })).rejects.toBeInstanceOf(AllAttemptsFailed);
    expect(calls.some((c) => c.mode === InferenceMode.ONLY_IN_CLOUD)).toBe(false);
  });

  it('every attempt failing produces one readable error', async () => {
    const engine = new HybridEngine(null, () => config, fakeFactory({
      [InferenceMode.ONLY_ON_DEVICE]: [() => new Error('boom')],
      [InferenceMode.ONLY_IN_CLOUD]: [() => new Error('API_NOT_ENABLED')],
    }, []));
    const err = await engine.run({ task: 'summarize', args: NOTE, decision: route(base), context: ctx }).catch((e) => e);
    expect(err).toBeInstanceOf(AllAttemptsFailed);
    expect(friendlyError(err)).toMatch(/All 2 attempts failed \(Gemini Nano → Cloud fallback\).*AI Logic is not enabled/);
  });

  it('uses Remote Config prompt templates', async () => {
    const calls: Calls[] = [];
    const engine = new HybridEngine(null, () => ({ ...config, promptTemplates: { summarize: 'ONE LINE ONLY.' } }), fakeFactory({
      [InferenceMode.ONLY_ON_DEVICE]: [() => 'ok'],
    }, calls));
    await engine.run({ task: 'summarize', args: NOTE, decision: route(base), context: ctx });
    expect(calls[0].prompt.startsWith('ONE LINE ONLY.')).toBe(true);
  });
});
