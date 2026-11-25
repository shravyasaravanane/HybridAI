/**
 * Inference ledger: one Firestore document per AI request, containing metadata
 * only (task, where it ran, why, latency, size, how many items were redacted).
 * Never the note text. Powers the Insights panel.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';
import type { Source } from '../ai/engine';

export interface LedgerEvent {
  id?: string;
  task: string;
  source: Source;
  mode: string;
  reason: string;
  latencyMs: number;
  chars: number;
  redactions: number;
  offline: boolean;
  at: number;
}

export interface LedgerStats {
  total: number;
  onDevice: number;
  inCloud: number;
  shieldedCloud: number;
  redactions: number;
  offlineRuns: number;
  charsKeptLocal: number;
  avgDeviceMs: number | null;
  avgCloudMs: number | null;
}

const MAX_EVENTS = 300;

export class Ledger {
  private events: LedgerEvent[] = [];
  private unsub: (() => void) | null = null;

  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
  ) {}

  private col() {
    return collection(this.db, 'users', this.uid, 'events');
  }

  start(onChange: (events: LedgerEvent[]) => void): void {
    const q = query(this.col(), orderBy('at', 'desc'), limit(MAX_EVENTS));
    this.unsub = onSnapshot(
      q,
      (snap) => {
        this.events = snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            task: String(x.task),
            source: x.source === 'on_device' ? 'on_device' : 'in_cloud',
            mode: String(x.mode ?? ''),
            reason: String(x.reason ?? ''),
            latencyMs: Number(x.latencyMs ?? 0),
            chars: Number(x.chars ?? 0),
            redactions: Number(x.redactions ?? 0),
            offline: Boolean(x.offline),
            at: x.at instanceof Timestamp ? x.at.toMillis() : Date.now(),
          } satisfies LedgerEvent;
        });
        onChange(this.events);
      },
      (err) => console.error('[ledger] snapshot error', err),
    );
  }

  stop(): void {
    this.unsub?.();
  }

  log(e: Omit<LedgerEvent, 'id' | 'at'>): void {
    addDoc(this.col(), { ...e, reason: e.reason.slice(0, 200), at: Timestamp.now() }).catch((err) =>
      console.error('[ledger] write failed', err),
    );
  }

  async clear(): Promise<void> {
    const snap = await getDocs(query(this.col(), limit(500)));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }
}

export function computeStats(events: LedgerEvent[]): LedgerStats {
  const dev = events.filter((e) => e.source === 'on_device');
  const cloud = events.filter((e) => e.source === 'in_cloud');
  const avg = (xs: LedgerEvent[]) => (xs.length ? Math.round(xs.reduce((s, e) => s + e.latencyMs, 0) / xs.length) : null);
  return {
    total: events.length,
    onDevice: dev.length,
    inCloud: cloud.length,
    shieldedCloud: cloud.filter((e) => e.redactions > 0).length,
    redactions: events.reduce((s, e) => s + e.redactions, 0),
    offlineRuns: events.filter((e) => e.offline).length,
    charsKeptLocal: dev.reduce((s, e) => s + e.chars, 0),
    avgDeviceMs: avg(dev),
    avgCloudMs: avg(cloud),
  };
}
