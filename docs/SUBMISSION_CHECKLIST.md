# #BuildHybridAI submission checklist

✅ done in the repo · ⏳ needs you (accounts, recording, publishing)

| # | Rule | Status | Satisfied by |
|---|---|---|---|
| 1 | AI runs through **Firebase AI Logic Hybrid Inference SDK** | ✅ | `firebase/ai` imported in [src/firebase.ts:27](../src/firebase.ts#L27), [src/ai/engine.ts:18](../src/ai/engine.ts#L18); `getAI` [src/firebase.ts:146](../src/firebase.ts#L146); `getGenerativeModel` [src/ai/engine.ts:90](../src/ai/engine.ts#L90) |
| 1 | On-device when available (Gemini Nano, Web) | ✅ | `ONLY_ON_DEVICE` / `PREFER_ON_DEVICE` in [src/ai/router.ts](../src/ai/router.ts), [src/ai/fallback.ts](../src/ai/fallback.ts); `initializeDeviceModel` [src/ai/device.ts:50](../src/ai/device.ts#L50) |
| 1 | Falls back to the cloud when it isn't | ✅ | SDK `PREFER_ON_DEVICE` fallback plus an explicit shielded cloud attempt: [src/ai/fallback.ts:49](../src/ai/fallback.ts#L49), [src/ai/engine.ts:152-220](../src/ai/engine.ts#L152-L220); tests [tests/engine.test.ts](../tests/engine.test.ts) |
| 1 | Imported **and called at runtime** (not just the README) | ✅ | `generateContent` [src/ai/engine.ts:236](../src/ai/engine.ts#L236), `generateContentStream` [src/ai/engine.ts:245](../src/ai/engine.ts#L245), called from the UI in [src/main.ts](../src/main.ts) `execute()` |
| 2 | **App Check** (debug tokens accepted) | ✅ / ⏳ | [src/firebase.ts:93-119](../src/firebase.ts#L93-L119); README "App Check debug token". ⏳ Register the app and enforce it in the console |
| 2 | **Remote Config** with real value | ✅ | Kill-switch, threshold, model, prompt templates, shield: [remoteconfig.template.json](../remoteconfig.template.json), [src/firebase.ts:161-173](../src/firebase.ts#L161-L173) |
| 2 | **Firestore** with real value | ✅ | Notes, settings and ledger with offline cache: [src/data/](../src/data); rules in [firestore.rules](../firestore.rules) |
| 2 | **Authentication** with real value | ✅ | Anonymous → Google linking: [src/data/auth.ts](../src/data/auth.ts) |
| 3 | Public GitHub/GitLab repo | ⏳ | https://github.com/shravyasaravanane/HybridAI. **Currently private**: Settings → General → Change visibility → Public |
| 3 | OSI license, detectable in **About** | ✅ / ⏳ | [LICENSE](../LICENSE) is the unmodified Apache-2.0 text at the repo root, which GitHub detects automatically. ⏳ Confirm "Apache-2.0" shows in About once public |
| 3 | All source, assets and run instructions | ✅ | `src/`, `public/`, `tests/`, config files; [README.md](../README.md) "Run it" |
| 3 | No secrets committed | ✅ | `.env*` git-ignored; [.env.example](../.env.example) documents every variable |
| 4 | Demo video ≤ 3 min, English, on the target platform, public YouTube | ⏳ | Script: [docs/DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md) |
| 5 | Text description: AI Logic usage, features, value proposition | ✅ | [docs/DEVPOST_SUBMISSION.md](DEVPOST_SUBMISSION.md) |
| 6 | Hosted, testable URL | ⏳ | `npm run deploy` → `https://<project>.web.app`; add it to the README and Devpost |
| 6 | Free to use | ✅ | No paywall; anonymous sign-in; Apache-2.0 |
| 7 | Multi-platform (optional) | ➖ | Single platform (Web). Portable policy layer and extension path: README "Extending to Android and iOS" |
| – | Tests for routing and fallback | ✅ | `npm test`: 41 tests in [tests/](../tests) |
| – | Pre-existing app disclosure | ✅ | Not needed: built during the submission period (stated in the Devpost text) |

## Final steps, in order
1. [ ] Firebase project: AI Logic (Gemini Developer API), Anonymous + Google Auth, Firestore, App Check (reCAPTCHA Enterprise + enforce)
2. [ ] `.env.local` → `npm run dev` → register the debug token → test with Gemini Nano **and** without it (cloud fallback)
3. [ ] `npm run deploy` (hosting, rules, Remote Config) → test the live URL in Chrome
4. [ ] Measure latency with Compare/Insights → fill in the README "Latency comparison" table
5. [ ] Make the repo **public**; check About shows Apache-2.0; replace the live-app and video placeholders in the README
6. [ ] Record and upload the video (Public, ≤ 3:00, English captions)
7. [ ] Devpost: platform **Web**, paste the description, add links to the repo, live app and video
