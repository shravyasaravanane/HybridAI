import { describe, expect, it } from 'vitest';
import { buildPrompt, parseJson, parseTemplates, TASKS } from '../src/ai/tasks';

describe('tasks', () => {
  it('parses fenced or chatty JSON', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Sure! {"tags":["x"]} hope that helps')).toEqual({ tags: ['x'] });
    expect(parseJson('not json')).toBeNull();
  });

  it('embeds instructions in the prompt (Gemini Nano receives no system instruction)', () => {
    const p = buildPrompt('summarize', { title: 'T', body: 'Body text' });
    expect(p).toContain('Summarize');
    expect(p).toContain('Body text');
    expect(p).not.toMatch(/Keep every placeholder/);
  });

  it('adds the placeholder rule only when shielded', () => {
    expect(buildPrompt('ask', { title: 'T', body: 'x', question: 'who?', shielded: true })).toMatch(/Keep every placeholder/);
  });

  it('structured tasks have a JSON schema', () => {
    for (const t of Object.values(TASKS)) expect(Boolean(t.schema)).toBe(t.structured);
  });
});

describe('Remote Config prompt templates', () => {
  it('replaces instructions but always keeps the note and the placeholder rule', () => {
    const p = buildPrompt('summarize', { title: 'T', body: 'SECRET BODY', shielded: true }, { summarize: 'Give one sentence.' });
    expect(p.startsWith('Give one sentence.')).toBe(true);
    expect(p).not.toContain('3 to 5');
    expect(p).toContain('SECRET BODY');
    expect(p).toMatch(/Keep every placeholder/);
  });

  it('fills {tone} and {question}, and appends the question if the template omits it', () => {
    expect(buildPrompt('rewrite', { title: '', body: 'b', tone: 'formal' }, { rewrite: 'Make it {tone}.' })).toContain('more formal');
    expect(buildPrompt('ask', { title: '', body: 'b', question: 'When?' }, { ask: 'Answer briefly.' })).toContain('QUESTION: When?');
  });

  it('ignores invalid, unknown or oversized templates', () => {
    expect(parseTemplates('not json')).toEqual({});
    expect(parseTemplates('')).toEqual({});
    expect(parseTemplates(JSON.stringify({ summarize: 'ok', hack: 'x', ask: 5, tags: 'y'.repeat(3000) }))).toEqual({ summarize: 'ok' });
  });
});
