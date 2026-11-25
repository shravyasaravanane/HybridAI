import { describe, expect, it } from 'vitest';
import {
  applyRedactions,
  chunkText,
  findPatternEntities,
  luhn,
  rehydrate,
  sanitizeModelEntities,
} from '../src/ai/privacy';

const SAMPLE = `Call Priya Sharma at +1 415-555-0142 or priya.sharma@lakeviewdental.example.
Card 4111 1111 1111 1111. SSN 123-45-6789. Server 192.168.1.20. Meeting on 2026-11-25 at 10:30, budget $4,000.`;

describe('pattern detection', () => {
  const found = findPatternEntities(SAMPLE);
  const byType = (t: string) => found.filter((e) => e.type === t).map((e) => e.text);

  it('finds emails, phones, cards, IDs and IPs', () => {
    expect(byType('EMAIL')).toEqual(['priya.sharma@lakeviewdental.example']);
    expect(byType('PHONE')).toEqual(['+1 415-555-0142']);
    expect(byType('CARD')).toEqual(['4111 1111 1111 1111']);
    expect(byType('ID')).toEqual(['123-45-6789']);
    expect(byType('IP')).toEqual(['192.168.1.20']);
  });

  it('does not flag dates, times or amounts', () => {
    const texts = found.map((e) => e.text).join('|');
    expect(texts).not.toMatch(/2026|10:30|4,000/);
  });

  it('validates cards with Luhn', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });
});

describe('redaction round-trip', () => {
  it('replaces every occurrence and restores it', () => {
    const text = 'Priya Sharma called. Priya Sharma wants a demo. Email priya@x.example.';
    const r = applyRedactions(text, [
      { text: 'Priya Sharma', type: 'PERSON', via: 'nano' },
      { text: 'priya@x.example', type: 'EMAIL', via: 'pattern' },
    ]);
    expect(r.redacted).toBe('[PERSON_1] called. [PERSON_1] wants a demo. Email [EMAIL_1].');
    expect(r.redacted).not.toContain('Priya');
    expect(r.entities.find((e) => e.type === 'PERSON')?.count).toBe(2);
    expect(rehydrate('- Follow up with [PERSON_1] via [EMAIL_1]', r.map)).toBe(
      '- Follow up with Priya Sharma via priya@x.example',
    );
  });

  it('prefers longer entities over substrings', () => {
    const r = applyRedactions('Priya Sharma and Priya', [
      { text: 'Priya', type: 'PERSON', via: 'nano' },
      { text: 'Priya Sharma', type: 'PERSON', via: 'nano' },
    ]);
    expect(r.redacted).toBe('[PERSON_1] and [PERSON_2]');
    expect(rehydrate(r.redacted, r.map)).toBe('Priya Sharma and Priya');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(rehydrate('[PERSON_9] said hi', { '[PERSON_1]': 'A' })).toBe('[PERSON_9] said hi');
  });
});

describe('model entity sanitizing', () => {
  it('drops hallucinated, generic and unknown-type entities', () => {
    const out = sanitizeModelEntities('Met Arjun at Lakeview Dental on Monday.', {
      entities: [
        { text: 'Arjun', type: 'PERSON' },
        { text: 'Lakeview Dental', type: 'org' },
        { text: 'Monday', type: 'PERSON' },
        { text: 'Rahul', type: 'PERSON' },
        { text: 'thing', type: 'WEAPON' },
      ],
    });
    expect(out.map((e) => `${e.type}:${e.text}`)).toEqual(['PERSON:Arjun', 'ORG:Lakeview Dental']);
  });

  it('handles malformed model output', () => {
    expect(sanitizeModelEntities('x', null)).toEqual([]);
    expect(sanitizeModelEntities('x', { entities: 'nope' })).toEqual([]);
  });
});

describe('chunking', () => {
  it('covers the whole text without loss', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(5000);
  });
});
