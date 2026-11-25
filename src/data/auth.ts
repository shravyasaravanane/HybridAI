/**
 * Authentication: every visitor gets an anonymous account instantly (no sign-up
 * wall for judges), and can upgrade to Google sign-in. Linking keeps the same
 * uid, so notes and history carry over.
 */
import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';

export function watchUser(auth: Auth, cb: (user: User) => void): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user) cb(user);
    else signInAnonymously(auth).catch((err) => console.error('[auth] anonymous sign-in failed', err));
  });
}

export async function signInWithGoogle(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  const current = auth.currentUser;
  if (current?.isAnonymous) {
    try {
      await linkWithPopup(current, provider);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // This Google account already has Tandem data: switch to it.
      if (code !== 'auth/credential-already-in-use' && code !== 'auth/email-already-in-use') throw err;
    }
  }
  await signInWithPopup(auth, provider);
}

export async function signOutUser(auth: Auth): Promise<void> {
  await signOut(auth); // watchUser() signs back in anonymously
}
