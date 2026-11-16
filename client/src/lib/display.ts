// Pure display helpers shared by the shell and pages (kept out of component files
// so React fast-refresh stays happy).

/** Prettify an email local-part into a display name: "jane.doe@x.com" → "Jane Doe". */
export function displayName(email: string | null | undefined): string {
  if (!email) return 'Signed in';
  const local = email.split('@')[0];
  const words = local.split(/[.\-_]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : local;
}

/** Two-letter initials for an avatar: "jane.doe@x.com" → "JD", "unknown" → "UN". */
export function initials(nameOrEmail: string | null | undefined): string {
  if (!nameOrEmail) return '?';
  const local = nameOrEmail.split('@')[0];
  const words = local.split(/[\s.\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand' | 'ink';

/** Map run statuses and approval states to a pill tone. */
export function statusTone(status: string | null | undefined): Tone {
  const s = (status ?? '').toLowerCase();
  if (s === 'success' || s === 'approved' || s === 'ready' || s === 'synced' || s === 'online' || s === 'active') return 'success';
  if (s === 'warnings' || s === 'warning' || s === 'in_review' || s === 'pending' || s === 'syncing' || s === 'updating' || s === 'creating') return 'warning';
  if (s === 'failed' || s === 'rejected' || s === 'error') return 'danger';
  return 'neutral';
}

/** Human label for a status value: "in_review" → "In review", "SUCCESS" → "Success". */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const s = status.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format a date as "Sep 17, 2026" and its time as "23:15" (local time). */
export function splitDateTime(value: string | number | Date | null | undefined): { date: string; time: string } {
  if (value === null || value === undefined || value === '') return { date: '—', time: '' };
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return { date: String(value), time: '' };
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}
