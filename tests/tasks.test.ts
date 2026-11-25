import { describe, expect, it } from 'vitest';
import { parseJson, TASKS } from '../src/ai/tasks';

describe('tasks', () => {
  it('parses fenced or chatty JSON', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Sure! {"tags":["x"]} hope that helps')).toEqual({ tags: ['x'] });
    expect(parseJson('not json')).toBeNull();
  });

  it('embeds instructions in the prompt (Gemini Nano receives no system instruction)', () => {
    const p = TASKS.summarize.build({ title: 'T', body: 'Body text' });
    expect(p).toContain('Summarize');
    expect(p).toContain('Body text');
    expect(p).not.toMatch(/Keep every placeholder/);
  });

  it('adds the placeholder rule only when shielded', () => {
    expect(TASKS.ask.build({ title: 'T', body: 'x', question: 'who?', shielded: true })).toMatch(/Keep every placeholder/);
  });

  it('structured tasks have a JSON schema', () => {
    for (const t of Object.values(TASKS)) expect(Boolean(t.schema)).toBe(t.structured);
  });
});
