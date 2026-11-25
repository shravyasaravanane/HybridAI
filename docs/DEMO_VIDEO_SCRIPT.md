# Demo video script (target 2:45, hard limit 3:00, English)

Record the **live hosted app** in Chrome desktop with Gemini Nano already downloaded. Use a clean profile, 1440×900, browser zoom 110%. Turn on captions in YouTube Studio, or burn in English subtitles. Upload as **Public**.

Before recording:
- Gemini Nano status shows **Gemini Nano ready**. Download it in a separate session first.
- A fresh account, so the three demo notes appear. Insights is empty.
- Firebase console open in a second tab: **Remote Config** with `on_device_max_chars`.
- Wi-Fi toggle within reach.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:15 | App opens; three demo notes; header shows **Online** and **Gemini Nano ready** | "On-device AI is fast, private and free, but it isn't on every device and it can't read long documents. Tandem Notes uses both, through Firebase AI Logic's hybrid inference." |
| 0:15–0:40 | Open *Welcome* note → **Summarize**. Point at the blue **On-device** badge, latency, and `InferenceMode.PREFER_ON_DEVICE` in the route card | "Short notes run on Gemini Nano, right here in Chrome. The badge comes from the SDK's inferenceSource, so it shows where the request actually ran. Here: on-device, in a few hundred milliseconds, and nothing was uploaded." |
| 0:40–1:15 | Open *Client call: Priya Sharma*. Switch routing to **Cloud** → **Summarize**. Show the *Privacy Shield redacted N items* line. Expand **What left my device**: `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]` | "When a request goes to the cloud, Gemini Nano first acts as a privacy filter. Names, emails, phone numbers, addresses and card numbers are replaced on-device. This is the exact prompt Gemini in the cloud received: placeholders only. The answer is restored locally, so I still see Priya's name." |
| 1:15–1:35 | Switch back to **Auto**. **Compare on-device vs cloud** → two cards stream side by side | "Compare runs the same prompt on-device and in the cloud, side by side, with the latency for each." |
| 1:35–1:55 | Firebase console → Remote Config: set `on_device_max_chars` to 500 → publish → reload app → the same note's route card shows **Cloud** "Long text…" → run **Action items** → checklist appears | "Routing is tuned live with Remote Config. Lower the on-device budget, and this note is now treated as a long document and goes to the cloud. Structured JSON output works in both places, so we get a real checklist." *(Reset the value afterwards.)* |
| 1:55–2:15 | Turn **Wi-Fi off**. Header shows **Offline**. Open the *device-only journal* → **Action items** → blue badge. Edit a note → "Saved offline · will sync" | "Offline, everything switches to on-device. This journal is device-only: it's never synced to Firestore, and the router will never send it to the cloud, not even in Cloud mode." |
| 2:15–2:35 | Wi-Fi back on → **Insights**: on-device %, latency tiles, redactions, routing log | "Insights shows where every request ran and why. It's stored in Firestore as metadata only, never note text." |
| 2:35–2:50 | Header → **Sign in** (Google) → notes stay | "Anonymous sign-in gets you started instantly, and linking Google keeps your notes. App Check protects every AI call." |
| 2:50–3:00 | Logo + "Tandem Notes · Firebase AI Logic hybrid · Web (Chrome) · Apache-2.0" | "Tandem Notes: your device thinks first, and the cloud only sees what it needs to." |
