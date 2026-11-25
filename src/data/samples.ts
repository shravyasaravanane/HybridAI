/** Seed notes created on first run so judges can try every feature immediately. All data is fictional. */
import type { Note } from './notes';

export const SAMPLE_NOTES: Partial<Note>[] = [
  {
    title: 'Client call: Priya Sharma (try Privacy Shield)',
    tags: ['demo', 'clients'],
    body: `Call with Priya Sharma from Lakeview Dental Clinic, 24 Nov.
Her email is priya.sharma@lakeviewdental.example and her mobile is +1 415-555-0142.
Office address: 1180 Harbor Street, Suite 4, Oakland CA 94607.
Insurance policy number 4111 1111 1111 1111 was flagged by billing (it is a test number).

Discussed:
- They want to move appointment reminders from SMS to WhatsApp before January.
- Budget approved by Dr. Martin Okafor, about $4,000 for setup.
- Concern: patient data must not be stored outside their region.

Next steps:
- I will send Priya a proposal by Friday.
- Daniel to check WhatsApp Business API pricing by next Wednesday.
- Schedule a demo with Dr. Okafor in the first week of December.

Tip: switch routing to "Cloud" and run Summarize, then open "What left my device" to see that the cloud model only received placeholders like [PERSON_1] and [EMAIL_1]. Emails, phones, card and ID numbers are caught by pattern rules everywhere; names and addresses are detected by Gemini Nano, so click "Get Gemini Nano" first.`,
  },
  {
    title: 'Journal: rough week (device-only)',
    tags: ['journal'],
    private: true,
    body: `This week was heavy. Mum's hospital appointment got moved again and I couldn't focus at work.
I keep promising myself I'll go to bed before midnight and then scroll until 1am.

Things that helped: the long walk on Sunday, calling Arjun, cooking a proper dinner on Wednesday.

For next week: book the follow-up for Mum, ask my manager about working from home on Thursdays, and sleep by 11:30.

This note is device-only: it is never synced to Firestore and AI on it always runs on Gemini Nano, on this device. Try Summarize or Action items.`,
  },
  {
    title: 'Welcome to Tandem Notes',
    tags: ['guide'],
    body: `Tandem Notes is a notebook where your device and the cloud think in tandem.

How routing works (Auto mode):
- Short notes run on Gemini Nano, on-device: fast, private, free, and works offline.
- Long documents (over the Remote Config limit) go to Gemini in the cloud.
- No on-device model? Firebase AI Logic falls back to the cloud automatically.
- Before anything goes to the cloud, the Privacy Shield redacts names, emails, phone numbers, addresses and ID numbers on-device, then restores them in the answer.

Try it:
1. Click "Get Gemini Nano" in the header if it is not ready yet.
2. Open a note and press Summarize, Action items, Title & tags, Rewrite or Ask.
3. Use Compare to race on-device against cloud on the same prompt.
4. Turn off Wi-Fi: notes and on-device AI keep working.
5. Open Insights to see where every request ran and why.`,
  },
];
