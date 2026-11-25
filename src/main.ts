import './styles.css';
import type { User } from 'firebase/auth';
import { InferenceMode } from 'firebase/ai';
import { initFirebase, isConfigured, loadAppConfig, RC_DEFAULTS, type AppConfig, type FirebaseServices } from './firebase';
import { route, fmt, type DeviceStatus, type Routing, type RouteDecision } from './ai/router';
import { describeDevice, downloadDeviceModel, probeDevice } from './ai/device';
import { friendlyError, HybridEngine, type RunResult, type Source } from './ai/engine';
import { TASKS, type ActionItem, type TagsResult, type TaskId, type Tone } from './ai/tasks';
import { NoteStore, type Note } from './data/notes';
import { computeStats, Ledger, type LedgerEvent } from './data/ledger';
import { signInWithGoogle, signOutUser, watchUser } from './data/auth';
import { SAMPLE_NOTES } from './data/samples';
import { h, renderMarkdown, timeAgo } from './ui/dom';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RunView {
  label: string;
  stage: string;
  text: string;
  source?: Source;
  expected: Source;
  result?: RunResult;
  error?: string;
}

interface State {
  user: User | null;
  notes: Note[];
  currentId: string | null;
  search: string;
  routing: Routing;
  online: boolean;
  device: DeviceStatus;
  downloadProgress: number | null;
  config: AppConfig;
  busy: boolean;
  runs: RunView[];
  compare: boolean;
  events: LedgerEvent[];
  insightsOpen: boolean;
  tone: Tone;
  question: string;
  selection: { start: number; end: number } | null;
  pane: 'list' | 'editor' | 'ai';
}

const ROUTING_KEY = 'tandem.routing';
const state: State = {
  user: null,
  notes: [],
  currentId: null,
  search: '',
  routing: (readPref(ROUTING_KEY) as Routing | null) ?? 'auto',
  online: navigator.onLine,
  device: 'unknown',
  downloadProgress: null,
  config: {
    cloudModel: RC_DEFAULTS.cloud_model,
    onDeviceMaxChars: RC_DEFAULTS.on_device_max_chars,
    privacyShieldEnabled: RC_DEFAULTS.privacy_shield_enabled,
    shieldMaxChunks: RC_DEFAULTS.shield_max_chunks,
    defaultRouting: 'auto',
    announcement: '',
  },
  busy: false,
  runs: [],
  compare: false,
  events: [],
  insightsOpen: false,
  tone: 'clearer',
  question: '',
  selection: null,
  pane: 'editor',
};

let fb: FirebaseServices;
let engine: HybridEngine;
let store: NoteStore | null = null;
let ledger: Ledger | null = null;
let saveTimer: number | undefined;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const root = document.getElementById('app')!;

function start(): void {
  if (!isConfigured) return renderSetup();
  boot().catch((err) => {
    console.error(err);
    root.replaceChildren(h('div', { class: 'setup' }, h('h1', {}, 'Something went wrong'), h('p', {}, friendlyError(err))));
  });
}

async function boot(): Promise<void> {
  fb = initFirebase();
  engine = new HybridEngine(fb.ai, () => state.config);
  buildShell();

  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  // Remote Config (non-blocking: defaults are already in place)
  loadAppConfig(fb.remoteConfig).then((cfg) => {
    state.config = cfg;
    if (!readPref(ROUTING_KEY)) state.routing = cfg.defaultRouting;
    renderHeader();
    renderBanner();
    renderMeta();
    renderRoute();
  });

  refreshDevice();
  setInterval(refreshDevice, 15_000);

  watchUser(fb.auth, onUser);

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[sw] registration failed', err));
  }
}

function onUser(user: User): void {
  const switched = state.user?.uid !== user.uid;
  state.user = user;
  renderHeader();
  if (!switched) return;

  store?.stop();
  ledger?.stop();
  state.notes = [];
  state.currentId = null;
  state.events = [];

  store = new NoteStore(fb.db, user.uid);
  ledger = new Ledger(fb.db, user.uid);
  let seededCheck = false;
  store.subscribe((notes) => {
    state.notes = notes;
    if (!seededCheck && store!.cloudLoaded) {
      seededCheck = true;
      void seedIfEmpty(user.uid);
    }
    if (!state.currentId || !notes.some((n) => n.id === state.currentId)) {
      state.currentId = notes[0]?.id ?? null;
      renderEditor();
    }
    renderList();
  });
  store.start();
  ledger.start((events) => {
    state.events = events;
    renderInsights();
  });
}

async function seedIfEmpty(uid: string): Promise<void> {
  const key = `tandem.seeded.${uid}`;
  if (!store || state.notes.length > 0 || readPref(key)) return;
  writePref(key, '1');
  // Created in order, so the last one (the welcome note) is newest and sits at the top.
  for (const n of SAMPLE_NOTES) {
    await store.create(n);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function refreshDevice(): Promise<void> {
  if (state.downloadProgress !== null) return; // download in progress owns the status
  const s = await probeDevice();
  if (s !== state.device) {
    state.device = s;
    renderHeader();
    renderRoute();
    renderMeta();
  }
}

function setOnline(v: boolean): void {
  state.online = v;
  renderHeader();
  renderRoute();
  renderMeta();
  toast(v ? 'Back online: cloud model available again.' : 'Offline: notes and Gemini Nano keep working on this device.');
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const el = {} as {
  header: HTMLElement;
  banner: HTMLElement;
  main: HTMLElement;
  list: HTMLElement;
  editor: HTMLElement;
  meta: HTMLElement;
  route: HTMLElement;
  actions: HTMLElement;
  output: HTMLElement;
  insights: HTMLElement;
  toast: HTMLElement;
  tabs: HTMLElement;
  title?: HTMLInputElement;
  body?: HTMLTextAreaElement;
  tagsRow?: HTMLElement;
  privacyBtn?: HTMLButtonElement;
};

function buildShell(): void {
  el.header = h('header', { class: 'topbar' });
  el.banner = h('div', { class: 'banner', hidden: true });
  el.list = h('div', { class: 'note-list', role: 'list' });
  el.editor = h('div', { class: 'editor-inner' });
  el.meta = h('footer', { class: 'editor-meta' });
  el.route = h('div', { class: 'route-card' });
  el.actions = h('div', { class: 'actions' });
  el.output = h('div', { class: 'output' });
  el.insights = h('div', { class: 'drawer-backdrop', hidden: true });
  el.toast = h('div', { class: 'toast', role: 'status', hidden: true });
  el.tabs = h('nav', { class: 'mobile-tabs' });

  const fileInput = h('input', { type: 'file', accept: '.txt,.md,.markdown,text/plain,text/markdown', hidden: true, onchange: onImport });
  const sidebar = h(
    'aside',
    { class: 'pane pane-list', 'aria-label': 'Notes' },
    h('div', { class: 'sidebar-top' },
      h('input', {
        class: 'search', type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes',
        oninput: (e: Event) => { state.search = (e.target as HTMLInputElement).value; renderList(); },
      }),
      h('div', { class: 'sidebar-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => void newNote(false) }, '+ New note'),
        h('button', { class: 'btn', title: 'New device-only note', onclick: () => void newNote(true) }, lockIcon(), 'Private'),
        h('button', { class: 'btn', title: 'Import a .txt or .md file', onclick: () => fileInput.click() }, 'Import'),
        fileInput,
      ),
    ),
    el.list,
  );

  const editor = h('section', { class: 'pane pane-editor', 'aria-label': 'Editor' }, el.editor, el.meta);
  const ai = h(
    'section',
    { class: 'pane pane-ai', 'aria-label': 'AI assistant' },
    el.route,
    el.actions,
    el.output,
  );

  el.main = h('main', { class: 'layout', 'data-pane': state.pane }, sidebar, editor, ai);
  root.replaceChildren(el.header, el.banner, el.main, el.tabs, el.insights, el.toast);

  renderHeader();
  renderBanner();
  renderActions();
  renderOutput();
  renderTabs();
  renderEditor();
}

function renderTabs(): void {
  const tab = (id: State['pane'], label: string) =>
    h('button', {
      class: `tab ${state.pane === id ? 'is-active' : ''}`,
      'aria-pressed': String(state.pane === id),
      onclick: () => { state.pane = id; el.main.dataset.pane = id; renderTabs(); },
    }, label);
  el.tabs.replaceChildren(tab('list', 'Notes'), tab('editor', 'Write'), tab('ai', 'AI'));
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(): void {
  if (!el.header) return;
  const d = state.device;
  const deviceClass = d === 'available' ? 'ok' : d === 'unavailable' ? 'off' : 'warn';
  const canDownload = (d === 'downloadable' || d === 'downloading') && state.downloadProgress === null;

  const devicePill = h('div', { class: `pill pill-${deviceClass}`, title: 'On-device model status (Chrome Prompt API)' },
    h('span', { class: 'dot dot-device' }),
    state.downloadProgress !== null
      ? h('span', {}, `Downloading Gemini Nano ${Math.round(state.downloadProgress * 100)}%`,
          h('span', { class: 'mini-progress' }, h('span', { style: { width: `${Math.round(state.downloadProgress * 100)}%` } })))
      : h('span', {}, describeDevice(d)),
    canDownload && h('button', { class: 'pill-btn', onclick: onDownload }, 'Get Gemini Nano'),
  );

  const netPill = h('div', { class: `pill ${state.online ? 'pill-ok' : 'pill-off'}` },
    h('span', { class: `dot ${state.online ? 'dot-online' : 'dot-offline'}` }), state.online ? 'Online' : 'Offline');

  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'AI routing' },
    ...(['auto', 'local', 'cloud'] as Routing[]).map((r) =>
      h('button', {
        role: 'radio', 'aria-checked': String(state.routing === r), class: state.routing === r ? 'is-on' : '',
        title: r === 'auto' ? 'Hybrid: on-device first, cloud for long docs or when no local model'
          : r === 'local' ? 'Never leave the device (Gemini Nano only)' : 'Always use the cloud model (with Privacy Shield)',
        onclick: () => { state.routing = r; writePref(ROUTING_KEY, r); renderHeader(); renderRoute(); },
      }, r === 'auto' ? 'Auto' : r === 'local' ? 'Local' : 'Cloud')));

  const u = state.user;
  const account = !u
    ? h('span', { class: 'muted small' }, 'Signing in…')
    : u.isAnonymous
      ? h('button', { class: 'btn btn-ghost', onclick: onGoogle, title: 'Keep your notes across devices' }, googleIcon(), 'Sign in')
      : h('button', { class: 'avatar', title: `${u.displayName ?? u.email ?? 'Account'}. Click to sign out`, onclick: onSignOut },
          (u.displayName ?? u.email ?? '?').slice(0, 1).toUpperCase());

  el.header.replaceChildren(
    h('div', { class: 'brand' },
      h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }),
      h('div', {}, h('div', { class: 'brand-name' }, 'Tandem Notes'), h('div', { class: 'brand-sub' }, 'On-device first · cloud when it counts'))),
    h('div', { class: 'topbar-right' },
      netPill, devicePill, seg,
      h('button', { class: 'btn btn-ghost', onclick: () => { state.insightsOpen = true; renderInsights(); } }, chartIcon(), 'Insights'),
      account),
  );
}

function renderBanner(): void {
  const text = state.config.announcement;
  el.banner.hidden = !text;
  el.banner.textContent = text;
}

async function onDownload(): Promise<void> {
  state.downloadProgress = 0;
  renderHeader();
  try {
    const s = await downloadDeviceModel(engine.deviceBootstrapModel(), (p) => {
      state.downloadProgress = p;
      renderHeader();
    });
    state.device = s;
    toast(s === 'available' ? 'Gemini Nano is ready: AI now runs on this device.' : 'Gemini Nano could not be installed on this device.');
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    state.downloadProgress = null;
    await refreshDevice();
    renderHeader();
    renderRoute();
  }
}

async function onGoogle(): Promise<void> {
  try {
    await signInWithGoogle(fb.auth);
    toast('Signed in with Google. Your notes now follow you.');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') toast(friendlyError(err));
  }
}

async function onSignOut(): Promise<void> {
  if (!confirm('Sign out? Device-only notes stay in this browser for this account.')) return;
  await signOutUser(fb.auth);
}

// ---------------------------------------------------------------------------
// Notes list
// ---------------------------------------------------------------------------

function renderList(): void {
  const q = state.search.trim().toLowerCase();
  const notes = state.notes.filter((n) => !q || `${n.title}\n${n.body}\n${n.tags.join(' ')}`.toLowerCase().includes(q));
  if (!notes.length) {
    el.list.replaceChildren(h('p', { class: 'empty' }, state.notes.length ? 'No notes match your search.' : store?.cloudLoaded ? 'No notes yet.' : 'Loading notes…'));
    return;
  }
  el.list.replaceChildren(
    ...notes.map((n) =>
      h('button', {
        class: `note-item ${n.id === state.currentId ? 'is-active' : ''}`,
        role: 'listitem',
        onclick: () => selectNote(n.id),
      },
        h('div', { class: 'note-item-title' }, n.private && lockIcon(), n.title || 'Untitled'),
        h('div', { class: 'note-item-snippet' }, n.body.slice(0, 90) || 'Empty note'),
        h('div', { class: 'note-item-meta' },
          h('span', {}, timeAgo(n.updatedAt)),
          n.private ? h('span', { class: 'chip chip-private' }, 'device-only') : n.pending ? h('span', { class: 'chip' }, 'syncing') : null,
          ...n.tags.slice(0, 3).map((t) => h('span', { class: 'chip' }, `#${t}`)),
        ),
      )),
  );
}

function selectNote(id: string): void {
  flushSave();
  state.currentId = id;
  state.selection = null;
  state.runs = [];
  state.pane = 'editor';
  el.main.dataset.pane = 'editor';
  renderTabs();
  renderList();
  renderEditor();
  renderOutput();
}

async function newNote(isPrivate: boolean, partial: Partial<Note> = {}): Promise<void> {
  if (!store) return;
  flushSave();
  const n = await store.create({ ...partial, private: isPrivate });
  selectNote(n.id);
  (partial.body ? el.body : el.title)?.focus();
}

async function onImport(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 190_000) return toast('That file is too large (max ~190 KB of text).');
  const body = await file.text();
  await newNote(false, { title: file.name.replace(/\.(txt|md|markdown)$/i, ''), body });
  toast(`Imported ${fmt(body.length)} characters.`);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function current(): Note | undefined {
  return state.currentId ? store?.get(state.currentId) : undefined;
}

function renderEditor(): void {
  const note = current();
  if (!note) {
    el.editor.replaceChildren(h('div', { class: 'empty-editor' }, h('p', {}, 'Select a note or create a new one.')));
    el.title = undefined;
    el.body = undefined;
    renderMeta();
    renderRoute();
    return;
  }
  el.title = h('input', {
    class: 'title-input', placeholder: 'Untitled', value: note.title, 'aria-label': 'Note title', maxlength: 200,
    oninput: () => { const n = current(); if (n) { n.title = el.title!.value; scheduleSave(n); } },
  });
  el.body = h('textarea', {
    class: 'body-input', placeholder: 'Start writing… (paste meeting notes, a journal entry, a long document)', 'aria-label': 'Note body',
    oninput: () => { const n = current(); if (n) { n.body = el.body!.value; scheduleSave(n); state.selection = null; renderMeta(); renderRoute(); } },
  });
  el.body.value = note.body;
  const trackSel = () => {
    const b = el.body!;
    const sel = b.selectionEnd - b.selectionStart > 20 ? { start: b.selectionStart, end: b.selectionEnd } : null;
    if (JSON.stringify(sel) !== JSON.stringify(state.selection)) {
      state.selection = sel;
      renderMeta();
      renderRoute();
    }
  };
  el.body.addEventListener('select', trackSel);
  el.body.addEventListener('keyup', trackSel);
  el.body.addEventListener('mouseup', trackSel);

  el.privacyBtn = h('button', {
    class: `btn btn-toggle ${note.private ? 'is-on' : ''}`,
    'aria-pressed': String(note.private),
    title: note.private ? 'Device-only: never synced, AI runs only on Gemini Nano' : 'Synced with Firestore. Click to make device-only',
    onclick: togglePrivate,
  }, lockIcon(), note.private ? 'Device-only' : 'Synced');

  el.tagsRow = h('div', { class: 'tags-row' });
  renderTags();

  el.editor.replaceChildren(
    el.title,
    h('div', { class: 'editor-toolbar' },
      el.privacyBtn,
      el.tagsRow,
      h('button', { class: 'btn btn-ghost danger', title: 'Delete note', onclick: onDelete }, 'Delete')),
    el.body,
  );
  renderMeta();
  renderRoute();
}

function renderTags(): void {
  const note = current();
  if (!note || !el.tagsRow) return;
  const add = h('input', {
    class: 'tag-input', placeholder: '+ tag', 'aria-label': 'Add tag', maxlength: 24,
    onkeydown: (e: KeyboardEvent) => {
      const v = (e.target as HTMLInputElement).value.trim().replace(/^#/, '').toLowerCase();
      if (e.key === 'Enter' && v) {
        if (!note.tags.includes(v) && note.tags.length < 10) note.tags.push(v);
        scheduleSave(note, true);
        renderTags();
      }
    },
  });
  el.tagsRow.replaceChildren(
    ...note.tags.map((t) =>
      h('span', { class: 'chip chip-tag' }, `#${t}`,
        h('button', { class: 'chip-x', 'aria-label': `Remove tag ${t}`, onclick: () => { note.tags = note.tags.filter((x) => x !== t); scheduleSave(note, true); renderTags(); } }, '×'))),
    add,
  );
}

function scheduleSave(note: Note, immediate = false): void {
  window.clearTimeout(saveTimer);
  const doSave = () => { saveTimer = undefined; void store?.save(note); };
  if (immediate) doSave();
  else saveTimer = window.setTimeout(doSave, 600);
  renderMeta();
}

function flushSave(): void {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const n = current();
  if (n) void store?.save(n);
}

async function togglePrivate(): Promise<void> {
  const note = current();
  if (!note || !store) return;
  flushSave();
  const toPrivate = !note.private;
  const msg = toPrivate
    ? 'Make this note device-only?\n\nIt will be removed from Firestore sync, kept only in this browser, and AI on it will only ever run on Gemini Nano.'
    : 'Sync this note?\n\nIt will be saved to your Firestore account and AI may use the cloud model (with Privacy Shield).';
  if (!confirm(msg)) return;
  const moved = await store.setPrivate(note, toPrivate);
  state.currentId = moved.id;
  renderEditor();
  toast(toPrivate ? 'Device-only: this note now never leaves this device.' : 'Synced: this note is now saved to Firestore.');
}

async function onDelete(): Promise<void> {
  const note = current();
  if (!note || !store) return;
  if (!confirm(`Delete "${note.title || 'Untitled'}"? This cannot be undone.`)) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  await store.remove(note);
  state.currentId = state.notes[0]?.id ?? null;
  state.runs = [];
  renderEditor();
  renderOutput();
}

/** The text the AI will operate on: the selection if there is one, else the whole note. */
function workingText(): { body: string; scope: 'selection' | 'note' } {
  const note = current();
  if (!note) return { body: '', scope: 'note' };
  if (state.selection) return { body: note.body.slice(state.selection.start, state.selection.end), scope: 'selection' };
  return { body: note.body, scope: 'note' };
}

function renderMeta(): void {
  if (!el.meta) return;
  const note = current();
  if (!note) return el.meta.replaceChildren();
  const { body, scope } = workingText();
  const max = state.config.onDeviceMaxChars;
  const pct = Math.min(100, (body.length / max) * 100);
  const fits = body.length <= max;
  const saveText = saveTimer !== undefined ? 'Saving…' : note.private ? 'Saved on this device only' : !state.online ? 'Saved offline · will sync' : note.pending ? 'Syncing…' : 'Saved · synced';
  el.meta.replaceChildren(
    h('div', { class: 'budget', title: 'Gemini Nano context budget (Remote Config: on_device_max_chars)' },
      h('div', { class: 'budget-bar' }, h('span', { class: fits ? 'fits' : 'over', style: { width: `${pct}%` } })),
      h('span', { class: 'small' },
        `${fmt(body.length)} / ${fmt(max)} chars${scope === 'selection' ? ' (selection)' : ''} · `,
        h('strong', {}, fits ? 'fits Gemini Nano' : 'cloud-sized'))),
    h('span', { class: 'small muted' }, saveText),
  );
}

// ---------------------------------------------------------------------------
// Routing preview + actions
// ---------------------------------------------------------------------------

function decide(chars: number, note: Note | undefined): RouteDecision {
  return route({
    routing: state.routing,
    online: state.online,
    device: state.device,
    chars,
    maxOnDeviceChars: state.config.onDeviceMaxChars,
    privateNote: Boolean(note?.private),
    privacyShieldEnabled: state.config.privacyShieldEnabled,
  });
}

function renderRoute(): void {
  if (!el.route) return;
  const note = current();
  const { body, scope } = workingText();
  const d = decide(body.length + (note?.title.length ?? 0), note);
  el.route.className = `route-card ${d.blocked ? 'is-blocked' : ''}`;
  el.route.replaceChildren(h('div', {},
    h('div', { class: 'route-label' }, 'Next request will run'),
    h('div', { class: 'route-where' },
      d.blocked ? h('span', { class: 'badge badge-blocked' }, 'Blocked') : sourceBadge(d.expected, true),
      h('code', { class: 'mode', title: 'Firebase AI Logic InferenceMode' }, modeName(d.mode))),
    h('p', { class: 'route-reason' }, d.blocked ?? d.reason),
    !d.blocked && d.expected === 'in_cloud' && h('p', { class: 'route-shield' }, shieldIcon(),
      d.shield
        ? state.device === 'available'
          ? 'Privacy Shield on: Gemini Nano and pattern rules redact personal data before upload.'
          : 'Privacy Shield on: pattern rules redact emails, phones, cards & IDs before upload.'
        : 'Privacy Shield is disabled by Remote Config.'),
    scope === 'selection' && h('p', { class: 'small muted' }, 'Using your text selection only.'),
  ));
  renderActions();
}

function renderActions(): void {
  if (!el.actions) return;
  const note = current();
  const blocked = note ? Boolean(decide(workingText().body.length + note.title.length, note).blocked) : true;
  const disabled = state.busy || !note || blocked;
  const btn = (id: TaskId) =>
    h('button', { class: 'action', disabled, onclick: () => void runTask(id) },
      h('span', { class: 'action-label' }, TASKS[id].label), h('span', { class: 'action-hint' }, TASKS[id].hint));
  const toneSel = h('select', {
    class: 'select', 'aria-label': 'Rewrite tone', disabled,
    onchange: (e: Event) => { state.tone = (e.target as HTMLSelectElement).value as Tone; },
  }, ...(['clearer', 'concise', 'formal', 'friendly'] as Tone[]).map((t) => h('option', { value: t, selected: state.tone === t }, `Tone: ${t}`)));
  const ask = h('input', {
    class: 'ask-input', placeholder: 'Ask something about this note…', 'aria-label': 'Question', disabled, maxlength: 300,
    value: state.question, oninput: (e: Event) => { state.question = (e.target as HTMLInputElement).value; },
  });
  const askGo = () => { const q = ask.value.trim(); if (q) void runTask('ask', q); };
  ask.addEventListener('keydown', (e) => { if (e.key === 'Enter') askGo(); });

  el.actions.replaceChildren(
    h('div', { class: 'action-grid' }, btn('summarize'), btn('actions'), btn('tags'),
      h('div', { class: 'action-combo' }, btn('rewrite'), toneSel)),
    h('div', { class: 'ask-row' }, ask, h('button', { class: 'btn btn-primary', disabled, onclick: askGo }, 'Ask')),
    h('button', {
      class: 'btn compare-btn', disabled,
      title: 'Run the same Summarize prompt with ONLY_ON_DEVICE and ONLY_IN_CLOUD side by side',
      onclick: () => void runCompare(),
    }, compareIcon(), 'Compare on-device vs cloud'),
  );
}

// ---------------------------------------------------------------------------
// Running AI
// ---------------------------------------------------------------------------

async function runTask(task: TaskId, question?: string): Promise<void> {
  const note = current();
  if (!note || state.busy) return;
  flushSave();
  await refreshDevice();
  const { body } = workingText();
  if (!body.trim()) return toast('Write something first.');
  const decision = decide(body.length + note.title.length, note);
  if (decision.blocked) return toast(decision.blocked);

  state.compare = false;
  state.runs = [{ label: TASKS[task].label, stage: 'Starting…', text: '', expected: decision.expected }];
  state.busy = true;
  state.pane = 'ai';
  el.main.dataset.pane = 'ai';
  renderTabs();
  renderActions();
  renderOutput();
  await execute(0, task, decision, { title: note.title, body, question, tone: state.tone });
  state.busy = false;
  renderActions();
}

async function runCompare(): Promise<void> {
  const note = current();
  if (!note || state.busy) return;
  flushSave();
  await refreshDevice();
  const { body } = workingText();
  if (!body.trim()) return toast('Write something first.');
  if (note.private) return toast('Device-only notes never go to the cloud, so there is nothing to compare.');
  if (!state.online) return toast('You are offline: the cloud side of the comparison is unavailable.');
  if (state.device !== 'available') return toast('Compare needs Gemini Nano on this device. Click "Get Gemini Nano" first.');
  if (body.length > state.config.onDeviceMaxChars) return toast('This text is too long for Gemini Nano. Select a shorter passage to compare.');

  const local: RouteDecision = { mode: InferenceMode.ONLY_ON_DEVICE, expected: 'on_device', reason: 'Compare: forced on-device', shield: false };
  const cloud: RouteDecision = { mode: InferenceMode.ONLY_IN_CLOUD, expected: 'in_cloud', reason: 'Compare: forced cloud', shield: state.config.privacyShieldEnabled };
  state.compare = true;
  state.runs = [
    { label: 'On-device · Gemini Nano', stage: 'Starting…', text: '', expected: 'on_device' },
    { label: `Cloud · ${state.config.cloudModel}`, stage: 'Starting…', text: '', expected: 'in_cloud' },
  ];
  state.busy = true;
  state.pane = 'ai';
  el.main.dataset.pane = 'ai';
  renderTabs();
  renderActions();
  renderOutput();
  const args = { title: note.title, body };
  await Promise.all([execute(0, 'summarize', local, args), execute(1, 'summarize', cloud, args)]);
  state.busy = false;
  renderActions();
}

async function execute(i: number, task: TaskId, decision: RouteDecision, args: { title: string; body: string; question?: string; tone?: Tone }): Promise<void> {
  const view = state.runs[i];
  let frame = 0;
  try {
    const result = await engine.run({
      task,
      args,
      decision,
      deviceReady: state.device === 'available',
      onStage: (s) => { view.stage = s; renderOutput(); },
      onText: (text, source) => {
        view.text = text;
        view.source = source;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(renderOutput);
      },
    });
    view.result = result;
    view.text = result.text;
    view.source = result.source;
    ledger?.log({
      task,
      source: result.source,
      mode: decision.mode,
      reason: decision.reason,
      latencyMs: result.latencyMs,
      chars: args.body.length,
      redactions: result.redaction?.entities.reduce((s, e) => s + e.count, 0) ?? 0,
      offline: !state.online,
    });
  } catch (err) {
    console.error(err);
    view.error = friendlyError(err);
  }
  cancelAnimationFrame(frame);
  renderOutput();
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function renderOutput(): void {
  if (!el.output) return;
  if (!state.runs.length) {
    el.output.replaceChildren(
      h('div', { class: 'output-empty' },
        h('p', {}, h('strong', {}, 'Pick an action above.')),
        h('p', { class: 'muted small' }, 'Every answer shows where it ran: on-device or in the cloud, how long it took, and exactly what (if anything) left your device.')),
    );
    return;
  }
  el.output.className = `output ${state.compare ? 'is-compare' : ''}`;
  el.output.replaceChildren(...state.runs.map(renderRun));
}

function renderRun(v: RunView): HTMLElement {
  const r = v.result;
  const header = h('div', { class: 'run-head' },
    h('span', { class: 'run-label' }, v.label),
    v.source ? sourceBadge(v.source) : h('span', { class: 'badge badge-pending' }, v.error ? 'Failed' : 'Working…'),
    r && h('span', { class: 'latency', title: r.shieldMs > 30 ? `Includes ${fmt(r.shieldMs)} ms of on-device Privacy Shield` : '' }, `${fmt(r.latencyMs)} ms`),
  );

  const body = h('div', { class: 'run-body' });
  if (v.error) {
    body.append(h('p', { class: 'error' }, v.error));
  } else if (!r && !v.text) {
    body.append(h('p', { class: 'muted small stage' }, h('span', { class: 'spinner' }), v.stage));
  } else if (r?.task === 'actions') {
    body.append(renderActionItems(r));
  } else if (r?.task === 'tags') {
    body.append(renderTagSuggestion(r));
  } else {
    const div = h('div', { class: 'md' });
    div.innerHTML = renderMarkdown(v.text);
    body.append(div);
    if (!r) body.append(h('span', { class: 'caret' }));
  }

  const parts: HTMLElement[] = [header];
  if (r?.redaction && r.redaction.entities.length) {
    const ents = r.redaction.entities;
    parts.push(h('div', { class: 'shield-chip' }, shieldIcon(),
      `Privacy Shield redacted ${ents.reduce((s, e) => s + e.count, 0)} item(s) before upload: `,
      summarizeTypes(ents.map((e) => e.type))));
  } else if (r?.decision.shield && r.source === 'in_cloud') {
    parts.push(h('div', { class: 'shield-chip' }, shieldIcon(), 'Privacy Shield found no personal data to redact.'));
  }
  parts.push(body);
  if (r && !v.error) parts.push(renderRunFooter(v, r));
  return h('article', { class: `run run-${v.source ?? v.expected}` }, ...parts);
}

function renderRunFooter(v: RunView, r: RunResult): HTMLElement {
  const note = current();
  const btns: HTMLElement[] = [];
  if (note && r.task === 'summarize' && !state.compare) {
    btns.push(h('button', { class: 'btn btn-small', onclick: () => applyToNote((b) => `Summary:\n${r.text.trim()}\n\n---\n\n${b}`, 'Summary added to the top of the note.') }, 'Insert at top'));
  }
  if (note && r.task === 'rewrite') {
    btns.push(h('button', { class: 'btn btn-small', onclick: () => applyToNote(() => r.text.trim(), 'Note replaced with the rewrite.') }, 'Replace note'));
  }
  btns.push(h('button', { class: 'btn btn-small btn-ghost', onclick: () => { void navigator.clipboard?.writeText(v.text); toast('Copied.'); } }, 'Copy'));

  const sent = h('details', { class: 'sent' },
    h('summary', {}, r.source === 'on_device' ? 'What left my device: nothing' : 'What left my device'),
    r.source === 'on_device'
      ? h('p', { class: 'small muted' }, 'This request ran on Gemini Nano inside Chrome. No text was sent to any server.')
      : h('div', {},
          h('p', { class: 'small muted' }, `Exact prompt sent to ${state.config.cloudModel} via Firebase AI Logic (${modeName(r.decision.mode)}). Reason: ${r.decision.reason}.`),
          h('pre', { class: 'prompt' }, r.sentPrompt)),
  );
  return h('div', { class: 'run-foot' }, h('div', { class: 'row gap-s wrap' }, ...btns), sent);
}

function renderActionItems(r: RunResult): HTMLElement {
  const items = ((r.data as { items?: ActionItem[] })?.items ?? []).filter((x) => x && typeof x.task === 'string' && x.task.trim());
  if (!items.length) return h('p', { class: 'muted' }, 'No action items found in this note.');
  const fmtItem = (x: ActionItem) => [x.task, x.owner && `owner: ${x.owner}`, x.due && `due: ${x.due}`].filter(Boolean).join(' · ');
  return h('div', {},
    h('ul', { class: 'checklist' }, ...items.map((x) =>
      h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), h('span', {}, x.task)),
        (x.owner || x.due) && h('span', { class: 'small muted' }, [x.owner, x.due].filter(Boolean).join(' · '))))),
    h('button', {
      class: 'btn btn-small',
      onclick: () => applyToNote((b) => `${b.trimEnd()}\n\nAction items:\n${items.map((x) => `- [ ] ${fmtItem(x)}`).join('\n')}\n`, 'Action items appended to the note.'),
    }, 'Append to note'),
  );
}

function renderTagSuggestion(r: RunResult): HTMLElement {
  const data = r.data as TagsResult | null;
  if (!data?.title) return h('p', { class: 'muted' }, 'The model did not return a usable title.');
  const tags = (data.tags ?? []).map((t) => String(t).toLowerCase().replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
  return h('div', {},
    h('p', { class: 'suggest-title' }, data.title),
    h('div', { class: 'row gap-s wrap' }, ...tags.map((t) => h('span', { class: 'chip chip-tag' }, `#${t}`))),
    h('button', {
      class: 'btn btn-small', style: { marginTop: '10px' },
      onclick: () => {
        const note = current();
        if (!note) return;
        note.title = data.title.slice(0, 200);
        note.tags = Array.from(new Set([...note.tags, ...tags])).slice(0, 10);
        scheduleSave(note, true);
        renderEditor();
        toast('Title and tags applied.');
      },
    }, 'Apply title & tags'),
  );
}

function applyToNote(fn: (body: string) => string, msg: string): void {
  const note = current();
  if (!note) return;
  const before = note.body;
  note.body = fn(before);
  scheduleSave(note, true);
  renderEditor();
  toast(msg, 'Undo', () => {
    const n = current();
    if (n && n.id === note.id) {
      n.body = before;
      scheduleSave(n, true);
      renderEditor();
    }
  });
}

// ---------------------------------------------------------------------------
// Insights drawer
// ---------------------------------------------------------------------------

function renderInsights(): void {
  el.insights.hidden = !state.insightsOpen;
  if (!state.insightsOpen) return;
  const s = computeStats(state.events);
  const devPct = s.total ? Math.round((s.onDevice / s.total) * 100) : 0;
  const close = () => { state.insightsOpen = false; renderInsights(); };

  const tile = (label: string, value: string, sub?: string) =>
    h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub && h('div', { class: 'tile-sub' }, sub));

  const split = s.total
    ? h('div', { class: 'split' },
        h('div', { class: 'split-legend' },
          h('span', {}, h('i', { class: 'sw sw-device' }), `On-device ${s.onDevice}`),
          h('span', {}, h('i', { class: 'sw sw-cloud' }), `Cloud ${s.inCloud}`)),
        h('div', { class: 'split-bar', role: 'img', 'aria-label': `${s.onDevice} on-device and ${s.inCloud} cloud requests` },
          s.onDevice > 0 && h('span', { class: 'seg seg-device', style: { flexGrow: String(s.onDevice) }, title: `On-device: ${s.onDevice} requests (${devPct}%)` }),
          s.inCloud > 0 && h('span', { class: 'seg seg-cloud', style: { flexGrow: String(s.inCloud) }, title: `Cloud: ${s.inCloud} requests (${100 - devPct}%)` })))
    : h('p', { class: 'muted small' }, 'Run an AI action to start the ledger.');

  const rows = state.events.slice(0, 40).map((e) =>
    h('tr', {},
      h('td', {}, timeAgo(e.at)),
      h('td', {}, TASKS[e.task as TaskId]?.label ?? e.task),
      h('td', {}, sourceBadge(e.source)),
      h('td', { class: 'num' }, `${fmt(e.latencyMs)} ms`),
      h('td', { class: 'num' }, e.redactions ? String(e.redactions) : '–'),
      h('td', { class: 'reason' }, e.offline ? `Offline · ${e.reason}` : e.reason)));

  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Insights' },
    h('div', { class: 'drawer-head' },
      h('div', {}, h('h2', {}, 'Insights'), h('p', { class: 'muted small' }, 'Where your AI requests ran, and why. Stored in Firestore as metadata only, never note text.')),
      h('button', { class: 'btn btn-ghost', onclick: close, 'aria-label': 'Close insights' }, '✕')),
    h('div', { class: 'tiles' },
      tile('Requests', fmt(s.total)),
      tile('Ran on-device', `${devPct}%`, `${fmt(s.onDevice)} requests · ${fmt(s.charsKeptLocal)} chars never uploaded`),
      tile('Cloud calls', fmt(s.inCloud), `${fmt(s.shieldedCloud)} with redactions`),
      tile('Items redacted', fmt(s.redactions), 'by the on-device Privacy Shield'),
      tile('Avg latency, on-device', s.avgDeviceMs === null ? '–' : `${fmt(s.avgDeviceMs)} ms`),
      tile('Avg latency, cloud', s.avgCloudMs === null ? '–' : `${fmt(s.avgCloudMs)} ms`),
    ),
    split,
    h('h3', {}, 'Routing log'),
    state.events.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'log' },
          h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Task'), h('th', {}, 'Ran'), h('th', { class: 'num' }, 'Latency'), h('th', { class: 'num' }, 'Redacted'), h('th', {}, 'Why'))),
          h('tbody', {}, ...rows)))
      : h('p', { class: 'muted small' }, 'No requests yet.'),
    h('div', { class: 'drawer-foot' },
      h('p', { class: 'small muted' }, `Cloud model: ${state.config.cloudModel} · On-device budget: ${fmt(state.config.onDeviceMaxChars)} chars · Privacy Shield: ${state.config.privacyShieldEnabled ? 'on' : 'off'} (Remote Config)`),
      state.events.length > 0 && h('button', {
        class: 'btn btn-small btn-ghost danger',
        onclick: async () => { if (confirm('Clear your routing history?')) { await ledger?.clear(); toast('History cleared.'); } },
      }, 'Clear history')),
  );
  el.insights.replaceChildren(drawer);
  el.insights.onclick = (e) => { if (e.target === el.insights) close(); };
  el.insights.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  (drawer.querySelector('button') as HTMLButtonElement | null)?.focus();
}

// ---------------------------------------------------------------------------
// Setup screen (no Firebase config)
// ---------------------------------------------------------------------------

function renderSetup(): void {
  root.replaceChildren(
    h('div', { class: 'setup' },
      h('img', { src: '/icon.svg', alt: '', width: 48, height: 48 }),
      h('h1', {}, 'Tandem Notes needs a Firebase project'),
      h('p', {}, 'Copy ', h('code', {}, '.env.example'), ' to ', h('code', {}, '.env.local'), ', fill in your Firebase web app config and App Check settings, then restart ', h('code', {}, 'npm run dev'), '.'),
      h('p', { class: 'muted' }, 'Full step-by-step instructions are in the README.')),
  );
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function sourceBadge(s: Source, expected = false): HTMLElement {
  return h('span', { class: `badge badge-${s}` }, h('span', { class: `dot ${s === 'on_device' ? 'dot-device' : 'dot-cloud'}` }),
    s === 'on_device' ? (expected ? 'On-device · Gemini Nano' : 'On-device') : expected ? `Cloud · ${state.config.cloudModel}` : 'Cloud');
}

function modeName(m: InferenceMode): string {
  return `InferenceMode.${String(m).toUpperCase()}`;
}

function summarizeTypes(types: string[]): string {
  const counts = new Map<string, number>();
  types.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
  return [...counts].map(([t, n]) => `${n} ${t.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
}

let toastTimer: number | undefined;
function toast(msg: string, actionLabel?: string, action?: () => void): void {
  window.clearTimeout(toastTimer);
  el.toast.replaceChildren(h('span', {}, msg));
  if (actionLabel && action) {
    el.toast.append(h('button', { class: 'toast-btn', onclick: () => { action(); el.toast.hidden = true; } }, actionLabel));
  }
  el.toast.hidden = false;
  toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, actionLabel ? 7000 : 4000);
}

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

function svg(path: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '14');
  s.setAttribute('height', '14');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'icon');
  s.innerHTML = path;
  return s;
}
const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const lockIcon = () => svg(`<rect x="5" y="11" width="14" height="10" rx="2" ${stroke}/><path d="M8 11V7a4 4 0 0 1 8 0v4" ${stroke}/>`);
const shieldIcon = () => svg(`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" ${stroke}/><path d="M9 12l2 2 4-4" ${stroke}/>`);
const chartIcon = () => svg(`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" ${stroke}/>`);
const compareIcon = () => svg(`<path d="M8 3v18M16 3v18M3 8h5M16 16h5" ${stroke}/>`);
const googleIcon = () => svg(`<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.7-1.6 2.7-4 2.7-7z" fill="#4285F4"/><path d="M12 21.5c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9.5 9.5 0 0 0 12 21.5z" fill="#34A853"/><path d="M6.7 13.8a5.7 5.7 0 0 1 0-3.6V7.7H3.5a9.5 9.5 0 0 0 0 8.6l3.2-2.5z" fill="#FBBC05"/><path d="M12 6.3c1.4 0 2.7.5 3.7 1.4l2.7-2.7A9.5 9.5 0 0 0 3.5 7.7l3.2 2.5C7.4 8 9.5 6.3 12 6.3z" fill="#EA4335"/>`);

// Start the app once every module-level binding above is initialized.
start();
