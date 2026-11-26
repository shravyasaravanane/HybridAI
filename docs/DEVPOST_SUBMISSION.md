# Devpost submission: Tandem Notes

**Tagline:** A private-first AI notebook. Gemini Nano answers on your device, Gemini in the cloud takes the long documents, and your personal data is redacted before anything leaves.

**Platform:** Web (Chrome) · **Built with:** firebase-ai-logic, gemini-nano, gemini, app-check, firebase-authentication, cloud-firestore, remote-config, firebase-hosting, typescript, vite, vitest

**Links:** Code https://github.com/shravyasaravanane/HybridAI · Live app `https://<project>.web.app` · Video `https://youtu.be/<id>`

---

## Description (paste into Devpost)

**The problem.** Students take notes on unreliable campus Wi-Fi, and everyone's notes hold private things: journals, client calls, health details. Cloud AI uploads every word and stops when the Wi-Fi does. On-device AI is private and works offline, but it isn't on every device and can't read long documents.

**What Tandem Notes does.** It's a notebook with Summarize, Action items, Title & tags, Rewrite and Ask-the-note, and every request is routed to the right place. Short notes run on Gemini Nano inside Chrome: instant, free, and working in airplane mode. Long documents go to Gemini in the cloud. Browsers without a local model fall back to the cloud automatically. Device-only notes never leave the device. Each answer shows an On-device or Cloud badge, the latency and a privacy note. A Compare button races both paths side by side.

**How we use Firebase AI Logic.** All AI runs through the Hybrid Inference SDK (`firebase/ai`). A tested router picks `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE` or `ONLY_IN_CLOUD` for each request, and we report where it really ran from the SDK's `inferenceSource`. We stream with `generateContentStream`, use one JSON Schema as both the on-device `responseConstraint` and the cloud `responseJsonSchema`, and download Nano with `initializeDeviceModel`. We read the SDK source and found that its fallback doesn't cover a mid-request Nano failure, and doesn't redact what it sends. So we built an explicit chain on top: Nano first, then a redacted cloud retry with backoff, and Nano as the backup when the cloud is down.

**Privacy Shield.** Before any cloud attempt, Gemini Nano and pattern rules replace names, emails, phone numbers and IDs with placeholders on the device. The answer is restored locally, and "What left my device" shows the exact prompt the cloud received.

**Firebase, each with a job.** App Check with limited-use tokens protects every Gemini call. Remote Config controls the routing threshold, cloud model, prompt templates and a cloud kill-switch, with no redeploy. Anonymous Auth upgrades to Google so notes follow you. Firestore syncs notes, settings and a metadata-only routing ledger with offline cache, under owner-only rules. Hosting serves an offline-capable app.

**Value.** Cloud-quality AI on long documents, plus on-device privacy, cost and offline reliability for everything else, with proof on screen. It's free and open source (Apache-2.0).

**What's new:** the whole project was built during the submission period.
