/**
 * Notes storage.
 *  - Synced notes: Firestore `users/{uid}/notes` with offline persistence.
 *  - Device-only notes: localStorage. They are never written to Firestore and
 *    the router only ever runs AI on them with InferenceMode.ONLY_ON_DEVICE.
 */
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /** Device-only note (never synced, AI never leaves the device). */
  private: boolean;
  createdAt: number;
  updatedAt: number;
  /** Firestore write not yet acknowledged by the server. */
  pending?: boolean;
}

type Listener = (notes: Note[]) => void;

const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 20);

export class NoteStore {
  private cloud: Note[] = [];
  private local: Note[] = [];
  private listeners = new Set<Listener>();
  private unsub: (() => void) | null = null;
  private readonly localKey: string;
  cloudLoaded = false;

  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
  ) {
    this.localKey = `tandem.deviceOnlyNotes.${uid}`;
    this.local = this.readLocal();
  }

  start(): void {
    const q = query(collection(this.db, 'users', this.uid, 'notes'), orderBy('updatedAt', 'desc'));
    this.unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        this.cloud = snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            title: String(x.title ?? ''),
            body: String(x.body ?? ''),
            tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
            private: false,
            createdAt: toMillis(x.createdAt),
            updatedAt: toMillis(x.updatedAt),
            pending: d.metadata.hasPendingWrites,
          };
        });
        this.cloudLoaded = true;
        this.emit();
      },
      (err) => {
        console.error('[notes] snapshot error', err);
        this.cloudLoaded = true;
        this.emit();
      },
    );
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.listeners.clear();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.all());
    return () => this.listeners.delete(fn);
  }

  all(): Note[] {
    return [...this.local, ...this.cloud].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Note | undefined {
    return this.local.find((n) => n.id === id) ?? this.cloud.find((n) => n.id === id);
  }

  async create(partial: Partial<Note> = {}): Promise<Note> {
    const now = Date.now();
    const note: Note = {
      id: newId(),
      title: partial.title ?? '',
      body: partial.body ?? '',
      tags: partial.tags ?? [],
      private: partial.private ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.save(note);
    return note;
  }

  async save(note: Note): Promise<void> {
    note.updatedAt = Date.now();
    if (note.private) {
      this.local = [note, ...this.local.filter((n) => n.id !== note.id)];
      this.writeLocal();
      this.emit();
      return;
    }
    // Optimistic local update; Firestore's offline cache also queues the write.
    this.cloud = [{ ...note, pending: true }, ...this.cloud.filter((n) => n.id !== note.id)];
    this.emit();
    // Not awaited: with offline persistence the promise only resolves once the server acks.
    setDoc(doc(this.db, 'users', this.uid, 'notes', note.id), {
      title: note.title.slice(0, 200),
      body: note.body,
      tags: note.tags.slice(0, 10),
      createdAt: Timestamp.fromMillis(note.createdAt),
      updatedAt: Timestamp.fromMillis(note.updatedAt),
    }).catch((err) => console.error('[notes] save failed', err));
  }

  async remove(note: Note): Promise<void> {
    if (note.private) {
      this.local = this.local.filter((n) => n.id !== note.id);
      this.writeLocal();
      this.emit();
      return;
    }
    this.cloud = this.cloud.filter((n) => n.id !== note.id);
    this.emit();
    deleteDoc(doc(this.db, 'users', this.uid, 'notes', note.id)).catch((err) => console.error('[notes] delete failed', err));
  }

  /** Moves a note between device-only storage and Firestore sync. */
  async setPrivate(note: Note, makePrivate: boolean): Promise<Note> {
    if (note.private === makePrivate) return note;
    await this.remove(note);
    const moved: Note = { ...note, private: makePrivate, pending: false };
    await this.save(moved);
    return moved;
  }

  private emit(): void {
    const notes = this.all();
    this.listeners.forEach((fn) => fn(notes));
  }

  private readLocal(): Note[] {
    try {
      const raw = localStorage.getItem(this.localKey);
      const parsed = raw ? (JSON.parse(raw) as Note[]) : [];
      return Array.isArray(parsed) ? parsed.map((n) => ({ ...n, private: true })) : [];
    } catch {
      return [];
    }
  }

  private writeLocal(): void {
    try {
      localStorage.setItem(this.localKey, JSON.stringify(this.local));
    } catch (err) {
      console.error('[notes] could not persist device-only notes', err);
    }
  }
}

function toMillis(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return Date.now();
}
