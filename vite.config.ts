import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // The Firebase SDK (App Check, Auth, Firestore, Remote Config, AI Logic) is the bulk of the bundle.
    chunkSizeWarningLimit: 1200,
  },
});
