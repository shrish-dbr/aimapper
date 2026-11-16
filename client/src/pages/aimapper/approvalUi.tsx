// Shared approval-workflow UI: status badge + role/state-aware action buttons.
// Used by both the History page (inline per row) and the Approvals queue.
import { Button } from '@databricks/appkit-ui/react';
import { Check, RotateCcw } from 'lucide-react';
import type { ApprovalAction } from '../../lib/aimapperApi';
import { StatusPill } from '../../components/studio';
import { statusTone } from '../../lib/display';

export const APPROVAL_LABEL: Record<string, string> = {
  in_review: 'In Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function approvalBadge(s: string | null) {
  const key = (s ?? 'in_review').toLowerCase();
  const tone = key in APPROVAL_LABEL ? statusTone(key) : statusTone('in_review');
  const label = key === 'in_review' ? 'In review' : (APPROVAL_LABEL[key] ?? key);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** Role- and state-aware approval buttons for a single item. */
export function ApprovalActions({
  appr,
  isEditor,
  busy,
  reviewedBy,
  onTransition,
  showReviewer = true,
}: {
  appr: string;
  isEditor: boolean;
  busy: boolean;
  reviewedBy: string | null;
  onTransition: (action: ApprovalAction) => void;
  // The "by <user>" reviewer label is useful on the Approvals queue but redundant on
  // History (where every row is approved); hide it there to keep the row narrow.
  showReviewer?: boolean;
}) {
  if (busy) return <span className="text-xs text-muted-foreground">Working…</span>;

  return (
    <span className="flex items-center gap-1.5 flex-nowrap whitespace-nowrap">
      {isEditor && appr === 'in_review' && (
        <>
          {/* Approve: solid success fill. Reject: brand-red outline. Both use
              semantic tokens so they read correctly in light AND dark mode. */}
          <Button
            size="sm"
            className="h-9 gap-1.5 px-3.5 bg-success text-white hover:bg-success/90"
            onClick={() => onTransition('approve')}
          >
            <Check className="h-4 w-4" /> Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-3.5 text-brand-soft-foreground hover:bg-danger-soft hover:text-brand-soft-foreground"
            onClick={() => onTransition('reject')}
          >
            Reject
          </Button>
        </>
      )}
      {isEditor && (appr === 'approved' || appr === 'rejected') && (
        <Button variant="outline" size="sm" className="h-9 gap-1.5 px-3.5" onClick={() => onTransition('reopen')} title="Reopen for review">
          <RotateCcw className="h-3.5 w-3.5" /> Reopen
        </Button>
      )}
      {showReviewer && (appr === 'approved' || appr === 'rejected') && reviewedBy && (
        <span className="text-[11px] text-muted-foreground" title={`Reviewed by ${reviewedBy}`}>by {reviewedBy.split('@')[0]}</span>
      )}
      {!isEditor && appr === 'in_review' && (
        <span className="text-xs text-muted-foreground">Awaiting review</span>
      )}
    </span>
  );
}
