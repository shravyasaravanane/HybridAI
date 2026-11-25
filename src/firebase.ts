/**
 * Firebase bootstrap: App, App Check, Auth, Firestore, Remote Config and
 * Firebase AI Logic. Everything else in the app imports from here.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  CustomProvider,
  type AppCheck,
} from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import {
  getRemoteConfig,
  fetchAndActivate,
  getValue,
  type RemoteConfig,
} from 'firebase/remote-config';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';

declare global {
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** True when the minimum config needed to talk to Firebase is present. */
export const isConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

/** Defaults mirror remoteconfig.template.json so the app works before the first fetch / offline. */
export const RC_DEFAULTS = {
  cloud_model: 'gemini-3.5-flash-lite',
  on_device_max_chars: 12000,
  privacy_shield_enabled: true,
  shield_max_chunks: 4,
  default_routing: 'auto',
  announcement: '',
} as const;

export interface AppConfig {
  cloudModel: string;
  onDeviceMaxChars: number;
  privacyShieldEnabled: boolean;
  shieldMaxChunks: number;
  defaultRouting: 'auto' | 'local' | 'cloud';
  announcement: string;
}

export interface FirebaseServices {
  app: FirebaseApp;
  appCheck: AppCheck;
  auth: Auth;
  db: Firestore;
  remoteConfig: RemoteConfig;
  ai: AI;
}

let services: FirebaseServices | null = null;

export function initFirebase(): FirebaseServices {
  if (services) return services;
  if (!isConfigured) throw new Error('Firebase is not configured. Copy .env.example to .env.local.');

  const app = initializeApp(firebaseConfig);

  // --- App Check (required by Firebase AI Logic) -------------------------
  // Debug tokens are accepted for hackathon judging; production uses reCAPTCHA Enterprise.
  const debugToken = (env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined)?.trim();
  if (debugToken) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === 'true' ? true : debugToken;
  }
  const siteKey = (env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined)?.trim();
  const provider = siteKey
    ? new ReCaptchaEnterpriseProvider(siteKey)
    : // With a debug token set, the SDK bypasses the provider entirely.
      new CustomProvider({
        getToken: () =>
          Promise.reject(
            new Error('No reCAPTCHA Enterprise site key configured; set VITE_APPCHECK_DEBUG_TOKEN for local use.'),
          ),
      });
  const appCheck = initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });

  // --- Auth ---------------------------------------------------------------
  const auth = getAuth(app);

  // --- Firestore with offline persistence (notes keep working offline) ----
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  // Optional: local Auth + Firestore emulators (`firebase emulators:start`). AI Logic always uses the real backend.
  if (env.VITE_USE_EMULATORS === 'true') {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  // --- Remote Config: tune routing without redeploying -------------------
  const remoteConfig = getRemoteConfig(app);
  remoteConfig.settings.minimumFetchIntervalMillis = env.DEV ? 60_000 : 60 * 60 * 1000;
  remoteConfig.settings.fetchTimeoutMillis = 8_000;
  remoteConfig.defaultConfig = { ...RC_DEFAULTS };

  // --- Firebase AI Logic (Gemini Developer API backend) -------------------
  // Limited-use App Check tokens enable replay protection for AI requests.
  const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });

  services = { app, appCheck, auth, db, remoteConfig, ai };
  return services;
}

export async function loadAppConfig(rc: RemoteConfig): Promise<AppConfig> {
  try {
    if (navigator.onLine) await fetchAndActivate(rc);
  } catch (err) {
    console.warn('[remote-config] using cached/default values', err);
  }
  return readAppConfig(rc);
}

export function readAppConfig(rc: RemoteConfig): AppConfig {
  const routing = getValue(rc, 'default_routing').asString();
  return {
    cloudModel: getValue(rc, 'cloud_model').asString() || RC_DEFAULTS.cloud_model,
    onDeviceMaxChars: getValue(rc, 'on_device_max_chars').asNumber() || RC_DEFAULTS.on_device_max_chars,
    privacyShieldEnabled: getValue(rc, 'privacy_shield_enabled').asBoolean(),
    shieldMaxChunks: getValue(rc, 'shield_max_chunks').asNumber() || RC_DEFAULTS.shield_max_chunks,
    defaultRouting: routing === 'local' || routing === 'cloud' ? routing : 'auto',
    announcement: getValue(rc, 'announcement').asString(),
  };
}
