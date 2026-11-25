# Devpost submission text: Tandem Notes

Copy these sections into the Devpost form.

**Project name:** Tandem Notes

**Tagline (≤ 200 chars):** A private-first AI notebook: Gemini Nano runs on your device, Gemini in the cloud handles long docs, and an on-device Privacy Shield redacts personal data before anything leaves.

**Platform:** Web (Chrome)

**Built with:** firebase-ai-logic, gemini-nano, gemini, chrome-built-in-ai, firebase-app-check, firebase-authentication, cloud-firestore, firebase-remote-config, firebase-hosting, typescript, vite, vitest

---

## Inspiration
Notes are where we put our most personal data: client calls, journals, health appointments, money. Today, adding AI to them means a trade-off. Cloud AI is powerful but uploads every word. On-device AI is private and free, but it isn't on every device and it can't handle long documents. Firebase AI Logic's hybrid SDK finally lets one app use both, so we asked: what if the app always picked the most private option that can still do the job, and showed you exactly what it did?

## What it does
Tandem Notes is a notebook with five AI actions: **Summarize, Action items, Title & tags, Rewrite and Ask the note**. Each request goes through a **Smart Router**:

- **Short notes run on Gemini Nano, on-device.** Instant, free, private, and they work offline.
- **Long documents go to Gemini in the cloud.** The threshold is set in Remote Config.
- **No local model in the browser?** The SDK's `PREFER_ON_DEVICE` mode falls back to the cloud automatically.
- **Before any text reaches the cloud, an on-device Privacy Shield runs.** Gemini Nano (forced `ONLY_ON_DEVICE`, JSON-constrained) plus deterministic rules replace names, emails, phone numbers, addresses, card and ID numbers with placeholders like `[PERSON_1]`. The cloud answer is re-hydrated locally, so you see real names while Google's servers only ever saw placeholders.
- **Device-only notes** are never synced and can only use `ONLY_ON_DEVICE`, even in Cloud mode.
- **Offline**, the app switches to `ONLY_ON_DEVICE` and notes keep saving to Firestore's offline cache.

Every answer shows a badge for **where it actually ran** (from the SDK's `inferenceSource`), the latency, and a **"What left my device"** panel with the exact prompt that was sent. A **Compare** button races `ONLY_ON_DEVICE` against `ONLY_IN_CLOUD` on the same prompt. **Insights** shows the on-device share, average latency for each side, items redacted, and a full routing log.

## How we built it (how we used Firebase AI Logic)
- **Firebase AI Logic Web SDK (`firebase/ai`)** with the Gemini Developer API backend. We build hybrid models with `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` for each `InferenceMode` (`PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `ONLY_IN_CLOUD`), chosen per request by a pure, unit-tested router.
- **Streaming** through `generateContentStream`. We read `chunk.inferenceSource` and `response.inferenceSource` to label every answer truthfully.
- **Structured output in both worlds:** one JSON Schema serves as the on-device `responseConstraint` and the cloud `responseJsonSchema`, which powers action-item checklists, auto title/tags, and Privacy Shield entity extraction.
- **`initializeDeviceModel()`** downloads Gemini Nano from a user click, with a live progress bar.
- **App Check** (required): reCAPTCHA Enterprise in production and debug tokens for development, with **limited-use tokens** (`useLimitedUseAppCheckTokens`) for replay protection.
- **Authentication:** instant anonymous sign-in (no sign-up wall), upgradeable to Google with `linkWithPopup` so notes keep the same uid.
- **Cloud Firestore** with persistent offline cache for notes, plus an inference ledger that stores **metadata only**, never note text. Owner-only security rules include field validation.
- **Remote Config** tunes the hybrid behaviour live: cloud model name, on-device character budget, Privacy Shield on/off, scan depth, default routing, and an announcement banner.
- **Firebase Hosting** serves an offline-capable PWA (service worker plus app-shell caching).
- Vanilla TypeScript and Vite, with no UI framework. Vitest covers the router, the Privacy Shield and the prompt builders.

## Challenges we ran into
- **System instructions don't reach Gemini Nano.** The Chrome adapter forwards only message contents, so every task builds one self-contained prompt that behaves the same on-device and in the cloud.
- **Small-model hallucinations in redaction.** Gemini Nano sometimes "finds" names that aren't in the text, so the shield keeps an entity only if it literally appears in the source, and it filters generic words.
- **Placeholders across streaming chunks.** A placeholder like `[PERSON_1]` can be split between chunks, so we re-hydrate the accumulated text on every chunk, not each chunk on its own.
- **Long documents vs. a ~9k-token local window.** Routing uses a Remote Config character budget, the shield scans long text in chunks, and users can select a passage to keep it on-device.

## Accomplishments that we're proud of
- A **"What left my device"** view that makes the privacy claim checkable rather than a promise.
- **Device-only notes**, with a hard guarantee in code (the router) and in storage (never written to Firestore).
- The **Compare** mode, which makes the hybrid trade-off visible: on-device latency and cost vs. cloud quality.

## What we learned
On-device and cloud models are not competitors. Used together, the local model can act as a **privacy gatekeeper** for the cloud model, which neither could do alone. Firebase AI Logic's single API across both made that possible without separate code paths.

## What's next for Tandem Notes
- Android (Gemini Nano) and iOS (Apple Foundation Models) clients using the same Firebase AI Logic hybrid pattern and Firestore data.
- Image notes (whiteboard photos) on-device with JPEG/PNG multimodal input.
- Per-note sensitivity classification by Gemini Nano to choose routing automatically.

---

## Links
- **Code (public, Apache-2.0):** https://github.com/<you>/tandem-notes
- **Live app:** https://<your-project>.web.app
- **Demo video (YouTube, public, ≤ 3 min):** https://youtu.be/<id>

## Testing instructions for judges
1. Open the live app in **Chrome 139+ desktop**. For on-device inference, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, restart Chrome, then click **Get Gemini Nano** in the header. Without it, everything still works through the cloud fallback.
2. Three demo notes are created automatically. Follow the "Judge's 2-minute tour" in the README.
3. Firebase AI Logic requires App Check. The hosted app uses reCAPTCHA Enterprise. For local runs, see the README (debug token).
