/**
 * HybridEngine: the single place where Tandem Notes calls Firebase AI Logic.
 *
 *  - Builds `GenerativeModel`s with hybrid params (`mode`, `onDeviceParams`, `inCloudParams`)
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
} from 'firebase/ai';
import type { AppConfig } from '../firebase';
import type { RouteDecision } from './router';
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
import { parseJson, TASKS, type TaskArgs, type TaskId } from './tasks';

export type Source = 'on_device' | 'in_cloud';

export interface RunResult {
  task: TaskId;
  text: string;
  /** Parsed JSON for structured tasks (placeholders already restored). */
  data?: unknown;
  source: Source;
  latencyMs: number;
  shieldMs: number;
  decision: RouteDecision;
  redaction?: Redaction;
  /** Exactly what was sent to the model (shown in the "What left my device" view). */
  sentPrompt: string;
}

export interface RunOptions {
  task: TaskId;
  args: TaskArgs;
  decision: RouteDecision;
  deviceReady: boolean;
  onText?: (text: string, source: Source | undefined) => void;
  onStage?: (stage: string) => void;
}

const SEP = '\n␞␞␞\n';

export class HybridEngine {
  private models = new Map<string, GenerativeModel>();

  constructor(
    private readonly ai: AI,
    private readonly config: () => AppConfig,
  ) {}

  /** Returns a cached hybrid model for (mode, cloud model, schema). */
  model(mode: InferenceMode, schema?: object): GenerativeModel {
    const cloudModel = this.config().cloudModel;
    const key = `${mode}|${cloudModel}|${schema ? JSON.stringify(schema) : 'text'}`;
    let m = this.models.get(key);
    if (!m) {
      m = getGenerativeModel(this.ai, {
        mode,
        onDeviceParams: schema
          ? { promptOptions: { responseConstraint: schema } }
          : undefined,
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
  deviceBootstrapModel(): GenerativeModel {
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
    const { task, decision, deviceReady, onText, onStage } = opts;
    const def = TASKS[task];
    const t0 = performance.now();

    // 1. Privacy Shield (only when the request may reach the cloud)
    let args: TaskArgs = { ...opts.args };
    let redaction: Redaction | undefined;
    if (decision.shield) {
      onStage?.(deviceReady ? 'Privacy Shield: scanning with Gemini Nano…' : 'Privacy Shield: scanning…');
      const joined = [args.title, args.body, args.question ?? ''].join(SEP);
      redaction = await this.shield(joined, deviceReady);
      const [title, body, question] = redaction.redacted.split(SEP);
      args = { ...args, title: title ?? '', body: body ?? '', question: question || args.question, shielded: redaction.entities.length > 0 };
    }
    const shieldMs = performance.now() - t0;
    const map = redaction?.map ?? {};

    // 2. Inference through Firebase AI Logic hybrid model
    const prompt = def.build(args);
    const model = this.model(decision.mode, def.schema);
    onStage?.(decision.expected === 'on_device' ? 'Running on-device…' : 'Running in the cloud…');

    let text = '';
    let source: Source = decision.expected;
    if (def.structured) {
      const res = await model.generateContent(prompt);
      text = res.response.text();
      source = (res.response.inferenceSource as Source | undefined) ?? source;
    } else {
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
        onText?.(rehydrate(text, map), source);
      }
      const final = await res.response;
      source = (final.inferenceSource as Source | undefined) ?? source;
    }

    const restored = rehydrate(text, map);
    let data: unknown;
    if (def.structured) {
      data = restoreDeep(parseJson(text), map);
      onText?.(restored, source);
    }
    return {
      task,
      text: restored,
      data,
      source,
      latencyMs: Math.round(performance.now() - t0),
      shieldMs: Math.round(shieldMs),
      decision,
      redaction,
      sentPrompt: prompt,
    };
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
  return msg;
}
