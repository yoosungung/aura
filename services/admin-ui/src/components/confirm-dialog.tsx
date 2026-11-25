import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** When true, reason textarea is required before confirm. */
  requireReason?: boolean;
  confirming?: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  requireReason = false,
  confirming = false,
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason('');
      setLocalError(null);
    }
  }, [open]);

  if (!open) return null;

  function handleConfirm() {
    const trimmed = reason.trim();
    if (requireReason && !trimmed) {
      setLocalError('reason_required');
      return;
    }
    setLocalError(null);
    onConfirm(requireReason ? trimmed : undefined);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      data-testid="confirm-dialog"
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-neutral-900">
          {title}
        </h2>
        <div className="mt-2 text-sm text-neutral-600">{description}</div>
        {requireReason ? (
          <div className="mt-3 space-y-1">
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="required"
              rows={3}
              disabled={confirming}
            />
          </div>
        ) : null}
        {localError ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {localError}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={confirming}>
            Cancel
          </Button>
          <Button
            type="button"
            id="btn-confirm-action"
            variant={destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
