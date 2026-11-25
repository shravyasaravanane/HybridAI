/**
 * The AI actions Tandem Notes offers. Each task builds a single self-contained
 * prompt (Gemini Nano on Chrome receives message contents only, so the
 * instructions live in the prompt itself and behave identically on-device and
 * in the cloud). Structured tasks share one JSON Schema used both as the
 * on-device `responseConstraint` and the cloud `responseJsonSchema`.
 */

export type TaskId = 'summarize' | 'actions' | 'tags' | 'rewrite' | 'ask';

export type Tone = 'clearer' | 'concise' | 'formal' | 'friendly';

export interface TaskArgs {
  title: string;
  body: string;
  tone?: Tone;
  question?: string;
  /** True when placeholders like [PERSON_1] are present (Privacy Shield active). */
  shielded?: boolean;
}

export interface TaskDef {
  id: TaskId;
  label: string;
  hint: string;
  structured: boolean;
  schema?: object;
  build(args: TaskArgs): string;
}

export interface ActionItem {
  task: string;
  owner?: string;
  due?: string;
}

export interface TagsResult {
  title: string;
  tags: string[];
}

const PLACEHOLDER_RULE =
  'The text contains privacy placeholders such as [PERSON_1] or [EMAIL_2]. Keep every placeholder exactly as written and never guess what it stands for.';

function wrap(args: TaskArgs, instructions: string[]): string {
  return [
    ...instructions,
    ...(args.shielded ? [PLACEHOLDER_RULE] : []),
    '',
    `NOTE TITLE: ${args.title || '(untitled)'}`,
    'NOTE:',
    '"""',
    args.body,
    '"""',
  ].join('\n');
}

export const ACTIONS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string' },
          due: { type: 'string' },
        },
        required: ['task'],
      },
    },
  },
  required: ['items'],
} as const;

export const TAGS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'tags'],
} as const;

const TONE_TEXT: Record<Tone, string> = {
  clearer: 'clearer and better organized, fixing grammar and spelling',
  concise: 'about half as long while keeping every important fact',
  formal: 'more formal and professional',
  friendly: 'warmer and more friendly',
};

export const TASKS: Record<TaskId, TaskDef> = {
  summarize: {
    id: 'summarize',
    label: 'Summarize',
    hint: '3-5 bullet TL;DR',
    structured: false,
    build: (a) =>
      wrap(a, [
        'Summarize the note below as 3 to 5 short Markdown bullet points ("- ").',
        'Lead with the single most important point. Use only facts from the note. Output only the bullets.',
      ]),
  },
  actions: {
    id: 'actions',
    label: 'Action items',
    hint: 'Extract to-dos as a checklist',
    structured: true,
    schema: ACTIONS_SCHEMA,
    build: (a) =>
      wrap(a, [
        'Extract every concrete action item, task or follow-up from the note below.',
        'For each, give a short imperative "task"; include "owner" and "due" only if the note states them.',
        'If there are no action items, return an empty list.',
      ]),
  },
  tags: {
    id: 'tags',
    label: 'Title & tags',
    hint: 'Auto-title and 3-5 tags',
    structured: true,
    schema: TAGS_SCHEMA,
    build: (a) =>
      wrap(a, [
        'Propose a specific title for the note below (max 8 words) and 3 to 5 lowercase topic tags (one or two words each, no "#").',
      ]),
  },
  rewrite: {
    id: 'rewrite',
    label: 'Rewrite',
    hint: 'Polish the note in a chosen tone',
    structured: false,
    build: (a) =>
      wrap(a, [
        `Rewrite the note below to be ${TONE_TEXT[a.tone ?? 'clearer']}.`,
        'Keep the same language, facts, names and Markdown structure. Output only the rewritten note, with no preamble.',
      ]),
  },
  ask: {
    id: 'ask',
    label: 'Ask the note',
    hint: 'Q&A grounded in this note',
    structured: false,
    build: (a) =>
      wrap(a, [
        'Answer the QUESTION using only information in the note below. Be brief (at most 4 sentences).',
        'If the note does not contain the answer, say "The note doesn\'t say." and nothing else.',
        `QUESTION: ${a.question ?? ''}`,
      ]),
  },
};

/** Parses model JSON defensively (models occasionally wrap JSON in code fences). */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}
