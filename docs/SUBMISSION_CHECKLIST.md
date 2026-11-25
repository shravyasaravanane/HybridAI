# #BuildHybridAI requirements checklist

| Requirement | Status | Where |
|---|---|---|
| Gen AI app using **Firebase AI Logic** | ✅ | `firebase/ai` imported and called at runtime: [src/firebase.ts](../src/firebase.ts) (`getAI`), [src/ai/engine.ts](../src/ai/engine.ts) (`getGenerativeModel`, `generateContent`, `generateContentStream`), [src/ai/device.ts](../src/ai/device.ts) (`initializeDeviceModel`) |
| **Hybrid inference**: on-device when available, cloud fallback | ✅ | `InferenceMode.PREFER_ON_DEVICE` / `ONLY_ON_DEVICE` / `ONLY_IN_CLOUD` chosen in [src/ai/router.ts](../src/ai/router.ts); real source from `inferenceSource` |
| Platform: **Web (Chrome)** with Gemini Nano | ✅ | Chrome Prompt API through the SDK's Chrome adapter. Select **Web** on Devpost |
| **App Check** (required; debug tokens accepted) | ✅ | [src/firebase.ts](../src/firebase.ts): reCAPTCHA Enterprise, plus debug token through `VITE_APPCHECK_DEBUG_TOKEN`, plus limited-use tokens |
| Other Firebase products (encouraged) | ✅ | Authentication (anonymous + Google), Firestore (notes + ledger + rules), Remote Config (6 params), Hosting |
| Public **GitHub/GitLab** repo with all source, assets and instructions | ⏳ you | Push this folder. README has setup, run, deploy and value proposition |
| **Open source license**, detectable in the About section | ✅ / ⏳ you | [LICENSE](../LICENSE) is the unmodified Apache-2.0 text, which GitHub detects automatically. Keep it at the repo root |
| Text description: Firebase AI Logic usage, features, value proposition | ✅ | [docs/DEVPOST_SUBMISSION.md](DEVPOST_SUBMISSION.md) |
| **Demo video** ≤ 3 min, public on YouTube, English, shows it running on the platform | ⏳ you | Script: [docs/DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md) |
| Hosted URL for judging (strongly encouraged) | ⏳ you | `npm run deploy` (Firebase Hosting) |
| Free of charge, English materials | ✅ | No paywall; all text in English |
| New project built during the submission period | ✅ | No "existing app" section needed |
| Google tools / Firebase agent skills (encouraged, optional) | optional | Mention that it was built with Claude Code if asked; the AI runs on Firebase AI Logic as required |

## Before you submit
- [ ] Firebase project created; AI Logic (Gemini Developer API), Anonymous + Google Auth, Firestore and App Check are all enabled
- [ ] `.env.local` filled in; `npm run dev` works; debug token registered
- [ ] `firebase deploy` done (hosting, firestore rules, remote config); reCAPTCHA Enterprise key has the `*.web.app` domain
- [ ] Tested on the hosted URL in Chrome with Gemini Nano **and** in a browser without it (cloud fallback)
- [ ] Repo is public; the About section shows "Apache-2.0"; README links to the live app and the video
- [ ] Video uploaded as Public on YouTube, ≤ 3:00, English or with English subtitles
- [ ] Devpost: platform = Web; links to repo, video and live app; testing instructions pasted
