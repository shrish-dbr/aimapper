// Shared "current mapping session" for the floating Genie assistant.
// The Mapper page publishes what is on screen; the assistant (mounted once in the
// app shell) reads it so mapping questions stay scoped to the current session.

export interface GenieSession {
  targetTable?: string;
  domain?: string;
  projectId?: string;
}

let current: GenieSession = {};
const listeners = new Set<() => void>();

export function setGenieSession(next: GenieSession): void {
  if (
    next.targetTable === current.targetTable &&
    next.domain === current.domain &&
    next.projectId === current.projectId
  ) return;
  current = { ...next };
  listeners.forEach((l) => l());
}

export function getGenieSession(): GenieSession {
  return current;
}

export function subscribeGenieSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
