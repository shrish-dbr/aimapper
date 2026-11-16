// Global tracker of in-flight API activity, page-agnostic (lives outside React so
// every page and the shared fetch helpers can use it).
//
// Three kinds of activity:
//   - 'quick'  (default): short data loads. Drive the thin TopProgressBar.
//   - 'long'   : user-visible operations that take many seconds (LLM mapping/SQL
//                generation, uploads, re-syncs). Shown as labelled cards in the
//                ActivityTray with elapsed time; they do NOT drive the thin bar.
//   - 'silent' : background polling/refreshes. Not shown anywhere (stops flicker).

export type ActivityKind = 'quick' | 'long' | 'silent';

export interface ActivityOptions {
  kind?: ActivityKind;
  /** Short user-facing label, e.g. "Generating SQL · general_ledger_detail". */
  label?: string;
  /** Typical duration range in seconds, shown as a hint (e.g. [15, 35]). */
  expectedSec?: [number, number];
}

export interface ActivityTask {
  id: number;
  label: string;
  expectedSec?: [number, number];
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}

// ---- quick requests -> thin bar (active/idle) ----
let pending = 0;
const listeners = new Set<(active: boolean) => void>();

function emit() {
  const active = pending > 0;
  for (const fn of listeners) fn(active);
}

/** Mark a quick request started. */
export function startRequest(): void {
  pending += 1;
  if (pending === 1) emit(); // transitioned idle → active
}

/** Mark a quick request finished (settled). */
export function endRequest(): void {
  pending = Math.max(0, pending - 1);
  if (pending === 0) emit(); // transitioned active → idle
}

/** Subscribe to quick-request active/idle changes; returns an unsubscribe fn. */
export function subscribeActivity(fn: (active: boolean) => void): () => void {
  listeners.add(fn);
  fn(pending > 0);
  return () => listeners.delete(fn);
}

// ---- long tasks → ActivityTray (labelled cards) ----
const DONE_LINGER_MS = 3500; // finished cards fade out after this
const ERROR_LINGER_MS = 12000; // errors stay longer (and can be dismissed)
let nextId = 1;
let tasks: ActivityTask[] = [];
const taskListeners = new Set<(tasks: ActivityTask[]) => void>();

function emitTasks() {
  const snapshot = tasks.slice();
  for (const fn of taskListeners) fn(snapshot);
}

/** Register a long task; returns its id. */
export function beginTask(label: string, expectedSec?: [number, number]): number {
  const id = nextId++;
  tasks = [...tasks, { id, label, expectedSec, startedAt: Date.now(), status: 'running' }];
  emitTasks();
  return id;
}

/** Mark a long task finished; it lingers briefly, then is removed. */
export function finishTask(id: number, error?: string): void {
  tasks = tasks.map((t) =>
    t.id === id ? { ...t, status: error ? 'error' : 'done', error, endedAt: Date.now() } : t,
  );
  emitTasks();
  setTimeout(() => dismissTask(id), error ? ERROR_LINGER_MS : DONE_LINGER_MS);
}

/** Remove a task card (user dismiss or auto-expiry). */
export function dismissTask(id: number): void {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  if (tasks.length !== before) emitTasks();
}

/** Subscribe to the long-task list; returns an unsubscribe fn. */
export function subscribeTasks(fn: (tasks: ActivityTask[]) => void): () => void {
  taskListeners.add(fn);
  fn(tasks.slice());
  return () => taskListeners.delete(fn);
}

/**
 * Run `work` while tracking it according to `opts.kind`:
 * quick → thin bar, long → labelled tray card, silent → untracked.
 */
export async function trackActivity<T>(opts: ActivityOptions | undefined, work: () => Promise<T>): Promise<T> {
  const kind = opts?.kind ?? 'quick';
  if (kind === 'silent') return work();
  if (kind === 'long') {
    const id = beginTask(opts?.label || 'Working…', opts?.expectedSec);
    try {
      const result = await work();
      finishTask(id);
      return result;
    } catch (e) {
      finishTask(id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
  startRequest();
  try {
    return await work();
  } finally {
    endRequest();
  }
}
