// Approval lifecycle state machine — pure and framework-free so both the route
// handler and unit tests share one source of truth.
//
// There is no 'draft' state: a saved mapping goes straight to 'in_review'. An editor
// then approves or rejects it, and can reopen a decided item back to review.

export type ApprovalStatus = 'in_review' | 'approved' | 'rejected';
export type ApprovalAction = 'approve' | 'reject' | 'reopen';

/** Allowed source states and the resulting state for each action. */
export const APPROVAL_TRANSITIONS: Record<ApprovalAction, { allowedFrom: ApprovalStatus[]; to: ApprovalStatus }> = {
  approve: { allowedFrom: ['in_review'], to: 'approved' },
  reject: { allowedFrom: ['in_review'], to: 'rejected' },
  reopen: { allowedFrom: ['approved', 'rejected'], to: 'in_review' },
};

/** Normalize a raw/nullable stored value to a valid ApprovalStatus. Legacy 'draft'
 * and NULL rows (pre-workflow, or before draft was removed) read as 'in_review'. */
export function normalizeApprovalStatus(raw: string | null | undefined): ApprovalStatus {
  const s = String(raw ?? '').toLowerCase();
  return s === 'approved' || s === 'rejected' ? s : 'in_review';
}

/** True when `action` stamps a reviewer (approve/reject); reopen clears it. */
export function stampsReviewer(action: ApprovalAction): boolean {
  return action === 'approve' || action === 'reject';
}

export type TransitionResult =
  | { ok: true; from: ApprovalStatus; to: ApprovalStatus }
  | { ok: false; status: 400 | 409; error: string };

/** Resolve a transition from the current state; returns the target or a typed error. */
export function resolveTransition(current: string | null | undefined, action: ApprovalAction): TransitionResult {
  const tr = APPROVAL_TRANSITIONS[action];
  if (!tr) return { ok: false, status: 400, error: `Unknown action '${action}'` };
  const from = normalizeApprovalStatus(current);
  if (!tr.allowedFrom.includes(from)) {
    return { ok: false, status: 409, error: `Cannot ${action} an item that is '${from}'.` };
  }
  return { ok: true, from, to: tr.to };
}
