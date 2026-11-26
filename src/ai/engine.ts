/**
 * HybridEngine: the single place where Tandem Notes calls Firebase AI Logic.
 *
 *  - Builds `GenerativeModel`s with hybrid params (`mode`, `onDeviceParams`, `inCloudParams`)
 *  - Runs the fallback chain from fallback.ts: Gemini Nano → shielded cloud
 *    (or cloud → Nano), with retries for transient cloud errors
 *  - Streams text, or uses structured JSON output (same JSON Schema on-device and in-cloud)
 *  - Reads `response.inferenceSource` to report where each request *actually* ran
 *  - Runs the Privacy Shield (on-device redaction) before anything may reach the cloud
 */
import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type AI,
  type GenerativeModel,
  type HybridParams,
} from 'firebase/ai';
import type { AppConfig } from '../firebase';
import type { RouteDecision } from './router';
import { AllAttemptsFailed, attemptChain, withRetry, type Attempt, type ChainContext } from './fallback';
import {
  applyRedactions,
  chunkText,
  ENTITY_SCHEMA,
  entityPrompt,
  findPatternEntities,
  rehydrate,
  sanitizeModelEntities,
  type Entity,
  type Redaction,
} from './privacy';
import { buildPrompt, parseJson, TASKS, type TaskArgs, type TaskId } from './tasks';

export type Source = 'on_device' | 'in_cloud';

/** The subset of GenerativeModel the engine uses (lets tests inject a fake). */
export type ModelLike = Pick<GenerativeModel, 'generateContent' | 'generateContentStream' | 'initializeDeviceModel'>;
export type ModelFactory = (params: HybridParams) => ModelLike;

export interface AttemptLog {
  label: string;
  mode: InferenceMode;
  ok: boolean;
  error?: string;
  retries: number;
}

export interface RunResult {
  task: TaskId;
  text: string;
  /** Parsed JSON for structured tasks (placeholders already restored). */
  data?: unknown;
  source: Source;
  /** InferenceMode of the attempt that produced the answer. */
  mode: InferenceMode;
  latencyMs: number;
  shieldMs: number;
  decision: RouteDecision;
  attempts: AttemptLog[];
  /** True when the first attempt failed and a later one answered. */
  fellBack: boolean;
  redaction?: Redaction;
  /** Exactly what was sent to the model that answered (shown in "What left my device"). */
  sentPrompt: string;
}

export interface RunOptions {
  task: TaskId;
  args: TaskArgs;
  decision: RouteDecision;
  context: ChainContext;
  /** Override the chain (Compare mode runs exactly one attempt per side). */
  attempts?: Attempt[];
  onText?: (text: string, source: Source | undefined) => void;
  onStage?: (stage: string) => void;
}

const SEP = '\n␞␞␞\n';

export class HybridEngine {
  private models = new Map<string, ModelLike>();
  private readonly factory: ModelFactory;

  constructor(
    ai: AI | null,
    private readonly config: () => AppConfig,
    factory?: ModelFactory,
  ) {
    this.factory = factory ?? ((params) => getGenerativeModel(ai!, params));
  }

  /** Returns a cached hybrid model for (mode, cloud model, schema). */
  model(mode: InferenceMode, schema?: object): ModelLike {
    const cloudModel = this.config().cloudModel;
    const key = `${mode}|${cloudModel}|${schema ? JSON.stringify(schema) : 'text'}`;
    let m = this.models.get(key);
    if (!m) {
      m = this.factory({
        mode,
        onDeviceParams: schema ? { promptOptions: { responseConstraint: schema } } : undefined,
        inCloudParams: {
          model: cloudModel,
          generationConfig: schema
            ? { responseMimeType: 'application/json', responseJsonSchema: schema as Record<string, unknown>, temperature: 0.2 }
            : { temperature: 0.4 },
        },
      });
      this.models.set(key, m);
    }
    return m;
  }

  /** Model used to trigger the Gemini Nano download from a user gesture. */
  deviceBootstrapModel(): ModelLike {
    return this.model(InferenceMode.PREFER_ON_DEVICE);
  }

  /** Named-entity detection with Gemini Nano, forced on-device (text never leaves the browser). */
  async detectEntitiesOnDevice(text: string): Promise<{ entities: Entity[]; scannedChars: number }> {
    const model = this.model(InferenceMode.ONLY_ON_DEVICE, ENTITY_SCHEMA);
    const chunks = chunkText(text).slice(0, Math.max(1, this.config().shieldMaxChunks));
    const entities: Entity[] = [];
    let scannedChars = 0;
    for (const chunk of chunks) {
      const res = await model.generateContent(entityPrompt(chunk));
      if (res.response.inferenceSource !== InferenceSource.ON_DEVICE) {
        throw new Error('Privacy Shield refused: entity detection did not run on-device.');
      }
      entities.push(...sanitizeModelEntities(chunk, parseJson(res.response.text())));
      scannedChars += chunk.length;
    }
    return { entities, scannedChars };
  }

  /** Redacts personal data locally. Patterns always run; Gemini Nano adds names/addresses when ready. */
  async shield(text: string, deviceReady: boolean): Promise<Redaction & { nanoScanned: number }> {
    const entities: Entity[] = findPatternEntities(text);
    let nanoScanned = 0;
    if (deviceReady) {
      try {
        const r = await this.detectEntitiesOnDevice(text);
        entities.push(...r.entities);
        nanoScanned = r.scannedChars;
      } catch (err) {
        console.warn('[privacy-shield] on-device entity detection failed; pattern redaction only', err);
      }
    }
    return { ...applyRedactions(text, entities), nanoScanned };
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const { task, decision, context, onText, onStage } = opts;
    const chain = opts.attempts ?? attemptChain(decision, context);
    if (!chain.length) throw new Error(decision.blocked ?? 'No way to run this request right now.');
    const t0 = performance.now();

    // The shield runs at most once, before the first attempt that may reach the cloud.
    let redaction: Redaction | undefined;
    let shieldMs = 0;
    const shielded = async (): Promise<{ args: TaskArgs; map: Record<string, string> }> => {
      if (!redaction) {
        const s0 = performance.now();
        onStage?.(context.deviceReady ? 'Privacy Shield: scanning with Gemini Nano…' : 'Privacy Shield: scanning…');
        const a = opts.args;
        redaction = await this.shield([a.title, a.body, a.question ?? ''].join(SEP), context.deviceReady);
        shieldMs = performance.now() - s0;
      }
      const [title, body, question] = redaction.redacted.split(SEP);
      return {
        args: { ...opts.args, title: title ?? '', body: body ?? '', question: question || opts.args.question, shielded: redaction.entities.length > 0 },
        map: redaction.map,
      };
    };

    const logs: AttemptLog[] = [];
    const failures: { label: string; error: unknown }[] = [];
    for (let i = 0; i < chain.length; i++) {
      const attempt = chain[i];
      const log: AttemptLog = { label: attempt.label, mode: attempt.mode, ok: false, retries: 0 };
      logs.push(log);
      try {
        const { args, map } = attempt.shield ? await shielded() : { args: opts.args, map: {} };
        const prompt = buildPrompt(task, args, this.config().promptTemplates);
        onStage?.(attempt.expected === 'on_device' ? `${attempt.label}: running on-device…` : `${attempt.label}: running in the cloud…`);
        const call = () => this.generate(task, attempt, prompt, map, onText);
        const out = attempt.retry
          ? await withRetry(call, {
              onRetry: (n) => {
                log.retries = n;
                onText?.('', undefined);
                onStage?.(`${attempt.label}: temporary error, retrying (${n}/2)…`);
              },
            })
          : await call();
        log.ok = true;
        return {
          task,
          ...out,
          mode: attempt.mode,
          latencyMs: Math.round(performance.now() - t0),
          shieldMs: Math.round(shieldMs),
          decision,
          attempts: logs,
          fellBack: i > 0,
          redaction: attempt.shield ? redaction : undefined,
          sentPrompt: prompt,
        };
      } catch (err) {
        log.error = friendlyError(err);
        failures.push({ label: attempt.label, error: err });
        console.warn(`[engine] ${attempt.label} failed`, err);
        const next = chain[i + 1];
        if (next) {
          onText?.('', undefined); // discard partial output from the failed attempt
          onStage?.(`${attempt.label} failed, switching to ${next.label}…`);
        }
      }
    }
    throw new AllAttemptsFailed(failures);
  }

  /** One model call (streaming for text tasks, JSON for structured tasks). */
  private async generate(
    task: TaskId,
    attempt: Attempt,
    prompt: string,
    map: Record<string, string>,
    onText?: RunOptions['onText'],
  ): Promise<{ text: string; data?: unknown; source: Source }> {
    const def = TASKS[task];
    const model = this.model(attempt.mode, def.schema);
    let text = '';
    let source: Source = attempt.expected;
    if (def.structured) {
      const res = await model.generateContent(prompt);
      text = res.response.text();
      source = (res.response.inferenceSource as Source | undefined) ?? source;
      const data = restoreDeep(parseJson(text), map);
      if (data === null || data === undefined) throw new Error('The model returned malformed JSON.');
      const restored = rehydrate(text, map);
      onText?.(restored, source);
      return { text: restored, data, source };
    }
    const res = await model.generateContentStream(prompt);
    for await (const chunk of res.stream) {
      let piece = '';
      try {
        piece = chunk.text();
      } catch {
        piece = '';
      }
      text += piece;
      if (chunk.inferenceSource) source = chunk.inferenceSource as Source;
      // Re-hydrate the whole accumulated text: a placeholder may be split across chunks.
      onText?.(rehydrate(text, map), source);
    }
    const final = await res.response;
    source = (final.inferenceSource as Source | undefined) ?? source;
    if (!text.trim()) throw new Error('The model returned an empty response.');
    return { text: rehydrate(text, map), source };
  }
}

function restoreDeep(v: unknown, map: Record<string, string>): unknown {
  if (typeof v === 'string') return rehydrate(v, map);
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, map));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, map)]));
  }
  return v;
}

/** Turns SDK errors into something a user (or judge) can act on. */
export function friendlyError(err: unknown): string {
  if (err instanceof AllAttemptsFailed) {
    const last = err.failures[err.failures.length - 1];
    const prefix = err.failures.length > 1 ? `All ${err.failures.length} attempts failed (${err.failures.map((f) => f.label).join(' → ')}). ` : '';
    return prefix + friendlyError(last.error);
  }
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';
  if (/app-check|appCheck|403|PERMISSION_DENIED/i.test(msg + code)) {
    return 'The cloud model rejected the request (App Check). Register your App Check debug token in the Firebase console, or configure reCAPTCHA Enterprise.';
  }
  if (/API_NOT_ENABLED|api-not-enabled|has not been used|is disabled/i.test(msg + code)) {
    return 'Firebase AI Logic is not enabled for this project. Open Firebase console > AI Logic and click "Get started" (Gemini Developer API).';
  }
  if (/ONLY_ON_DEVICE|on-device model is not available|LanguageModel API not available/i.test(msg)) {
    return 'The on-device model is not available in this browser. Use Chrome 139+ with the Prompt API flag enabled, or switch routing to Auto.';
  }
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(msg + code)) {
    return 'The cloud model quota is exhausted right now. Try again shortly, or switch to Local mode to keep working on-device.';
  }
  if (/Failed to fetch|NetworkError|network/i.test(msg)) {
    return 'Network error while reaching the cloud model. Switch to Local mode to keep working offline.';
  }
  if (/input is too large|too many tokens|QuotaExceededError/i.test(msg)) {
    return 'This text is too long for Gemini Nano. Select a shorter passage, or use Auto/Cloud routing.';
  }
  return msg;
}
