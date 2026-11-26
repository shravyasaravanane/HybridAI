/**
 * Per-user settings synced through Firestore (`users/{uid}/settings/app`), so
 * the routing preference follows the user across devices once they sign in
 * with Google. Works offline via the Firestore cache.
 */
import { doc, onSnapshot, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import type { Routing } from '../ai/router';

export interface UserSettings {
  routing?: Routing;
}

const isRouting = (v: unknown): v is Routing => v === 'auto' || v === 'local' || v === 'cloud';

export function watchSettings(db: Firestore, uid: string, cb: (s: UserSettings) => void): () => void {
  return onSnapshot(
    doc(db, 'users', uid, 'settings', 'app'),
    (snap) => {
      const data = snap.data();
      cb({ routing: isRouting(data?.routing) ? data.routing : undefined });
    },
    (err) => console.warn('[settings] snapshot error', err),
  );
}

export function saveSettings(db: Firestore, uid: string, s: UserSettings): void {
  setDoc(doc(db, 'users', uid, 'settings', 'app'), { ...s, updatedAt: Timestamp.now() }, { merge: true }).catch((err) =>
    console.warn('[settings] save failed', err),
  );
}
