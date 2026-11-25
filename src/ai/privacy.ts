/**
 * Privacy Shield: before any prompt can reach the cloud model, personal data is
 * replaced by placeholders like [PERSON_1] / [EMAIL_1]. Detection runs locally:
 *   1. deterministic patterns (emails, phones, cards w/ Luhn, IDs, IPs), always on
 *   2. Gemini Nano entity extraction (names, addresses, places, orgs) when the
 *      on-device model is available. See engine.ts `detectEntitiesOnDevice`.
 * The cloud response is then re-hydrated locally, so the user sees real names
 * but Google's servers only ever saw placeholders.
 *
 * This module is pure (no Firebase / DOM) and is unit-tested.
 */

export type EntityType =
  | 'EMAIL'
  | 'PHONE'
  | 'CARD'
  | 'ID'
  | 'IP'
  | 'PERSON'
  | 'ADDRESS'
  | 'LOCATION'
  | 'ORG';

export interface Entity {
  text: string;
  type: EntityType;
  via: 'pattern' | 'nano';
}

export interface RedactedEntity extends Entity {
  placeholder: string;
  count: number;
}

export interface Redaction {
  /** Text that is safe to send to the cloud. */
  redacted: string;
  entities: RedactedEntity[];
  /** placeholder -> original */
  map: Record<string, string>;
}

const PATTERNS: { type: EntityType; re: RegExp; accept?: (m: string) => boolean }[] = [
  { type: 'EMAIL', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'ID', re: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN format
  { type: 'ID', re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g }, // 12-digit national IDs (e.g. Aadhaar)
  { type: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    type: 'PHONE',
    re: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]?\d{2,5}){1,4}(?![\w])/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, '').length;
      // Avoid dates/years/plain numbers: phones have 9-15 digits and at least one separator or a leading +.
      return digits >= 9 && digits <= 15 && (/[\s().-]/.test(m.trim()) || m.trim().startsWith('+') || digits >= 10);
    },
  },
];

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Deterministic, model-free detection. Overlapping matches are resolved by pattern priority. */
export function findPatternEntities(text: string): Entity[] {
  const taken: [number, number][] = [];
  const out: Entity[] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const { type, re, accept } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const raw = m[0].trim();
      const start = (m.index ?? 0) + m[0].indexOf(raw);
      const end = start + raw.length;
      if (!raw || overlaps(start, end) || (accept && !accept(raw))) continue;
      taken.push([start, end]);
      out.push({ text: raw, type, via: 'pattern' });
    }
  }
  return out;
}

const NANO_TYPES = new Set<EntityType>(['PERSON', 'ADDRESS', 'LOCATION', 'ORG', 'ID', 'EMAIL', 'PHONE']);
/** Words a small model sometimes returns as "entities" that are not personal data. */
const STOP = new Set(['i', 'me', 'you', 'we', 'he', 'she', 'they', 'team', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

/**
 * Validates model-proposed entities: only keep strings that literally occur in
 * the source text (guards against hallucinations) and look like real entities.
 */
export function sanitizeModelEntities(text: string, raw: unknown): Entity[] {
  const list = (raw as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) return [];
  const out: Entity[] = [];
  for (const item of list) {
    const t = typeof item?.text === 'string' ? item.text.trim() : '';
    const type = typeof item?.type === 'string' ? (item.type.toUpperCase() as EntityType) : undefined;
    if (!t || !type || !NANO_TYPES.has(type)) continue;
    if (t.length < 2 || t.length > 120 || STOP.has(t.toLowerCase())) continue;
    if (!text.includes(t)) continue;
    out.push({ text: t, type, via: 'nano' });
  }
  return out;
}

/** Replaces every occurrence of every entity with a stable placeholder. */
export function applyRedactions(text: string, entities: Entity[]): Redaction {
  // Unique by text; longer strings first so "Priya Sharma" wins over "Priya".
  const unique = new Map<string, Entity>();
  for (const e of entities) if (!unique.has(e.text)) unique.set(e.text, e);
  const ordered = [...unique.values()].sort((a, b) => b.text.length - a.text.length);

  const counters: Partial<Record<EntityType, number>> = {};
  const map: Record<string, string> = {};
  const result: RedactedEntity[] = [];
  let redacted = text;
  for (const e of ordered) {
    const parts = redacted.split(e.text);
    const count = parts.length - 1;
    if (count === 0) continue; // already swallowed by a longer entity
    const n = (counters[e.type] = (counters[e.type] ?? 0) + 1);
    const placeholder = `[${e.type}_${n}]`;
    redacted = parts.join(placeholder);
    map[placeholder] = e.text;
    result.push({ ...e, placeholder, count });
  }
  return { redacted, entities: result, map };
}

/** Restores originals in model output. Unknown placeholders are left as-is. */
export function rehydrate(text: string, map: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\[([A-Z]+)_(\d+)\]/g, (ph) => map[ph] ?? ph);
}

/** Splits long text into chunks at whitespace for on-device entity detection. */
export function chunkText(text: string, size = 8000): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const ws = text.lastIndexOf('\n', end) > i + size * 0.6 ? text.lastIndexOf('\n', end) : text.lastIndexOf(' ', end);
      if (ws > i) end = ws;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

export const ENTITY_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['PERSON', 'ADDRESS', 'LOCATION', 'ORG', 'ID', 'EMAIL', 'PHONE'] },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['entities'],
} as const;

export function entityPrompt(chunk: string): string {
  return [
    'You are a privacy filter. Find personal or identifying information in the TEXT below.',
    'Return every: person name (PERSON), street/postal address (ADDRESS), specific private place such as a home town or clinic (LOCATION),',
    'employer/school/clinic name tied to a person (ORG), account/ID/policy number (ID), email (EMAIL), phone number (PHONE).',
    'Copy each item EXACTLY as it appears in the text. Do not include generic words. If none, return an empty list.',
    '',
    'TEXT:',
    '"""',
    chunk,
    '"""',
  ].join('\n');
}
