import { describe, it, expect } from 'vitest';
import { resolveTransition, normalizeApprovalStatus, stampsReviewer } from '../server/aimapper/approval.js';

describe('approval state machine (no draft)', () => {
  it('allows the happy path: in_review → approved/rejected, and reopen back to review', () => {
    expect(resolveTransition('in_review', 'approve')).toEqual({ ok: true, from: 'in_review', to: 'approved' });
    expect(resolveTransition('in_review', 'reject')).toEqual({ ok: true, from: 'in_review', to: 'rejected' });
    expect(resolveTransition('approved', 'reopen')).toEqual({ ok: true, from: 'approved', to: 'in_review' });
    expect(resolveTransition('rejected', 'reopen')).toEqual({ ok: true, from: 'rejected', to: 'in_review' });
  });

  it('rejects invalid transitions with 409', () => {
    expect(resolveTransition('approved', 'approve')).toMatchObject({ ok: false, status: 409 });
    expect(resolveTransition('rejected', 'reject')).toMatchObject({ ok: false, status: 409 });
    expect(resolveTransition('in_review', 'reopen')).toMatchObject({ ok: false, status: 409 });
    expect(resolveTransition('approved', 'reject')).toMatchObject({ ok: false, status: 409 });
  });

  it('treats null / unknown / legacy draft status as in_review', () => {
    expect(normalizeApprovalStatus(null)).toBe('in_review');
    expect(normalizeApprovalStatus(undefined)).toBe('in_review');
    expect(normalizeApprovalStatus('')).toBe('in_review');
    expect(normalizeApprovalStatus('draft')).toBe('in_review');
    expect(normalizeApprovalStatus('bogus')).toBe('in_review');
    // A NULL/legacy-draft row is treated as in_review — approvable, not reopenable.
    expect(resolveTransition(null, 'approve')).toEqual({ ok: true, from: 'in_review', to: 'approved' });
    expect(resolveTransition('draft', 'reopen')).toMatchObject({ ok: false, status: 409 });
  });

  it('is case-insensitive on the stored status', () => {
    expect(resolveTransition('IN_REVIEW', 'approve')).toEqual({ ok: true, from: 'in_review', to: 'approved' });
  });

  it('stamps a reviewer only for decisions', () => {
    expect(stampsReviewer('approve')).toBe(true);
    expect(stampsReviewer('reject')).toBe(true);
    expect(stampsReviewer('reopen')).toBe(false);
  });
});
