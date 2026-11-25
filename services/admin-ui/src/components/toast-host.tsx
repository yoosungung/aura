import { useToast } from '@/stores/toast';
import { cn } from '@/lib/utils';

export function ToastHost() {
  const items = useToast((s) => s.items);
  const dismiss = useToast((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-sm',
            t.tone === 'error' && 'border-red-200 bg-red-50 text-red-800',
            t.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
            t.tone === 'info' && 'border-neutral-200 bg-white text-neutral-800'
          )}
          role="status"
        >
          <div className="flex items-start justify-between gap-2">
            <span>{t.message}</span>
            <button
              type="button"
              className="text-xs text-neutral-500 hover:text-neutral-800"
              onClick={() => dismiss(t.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
