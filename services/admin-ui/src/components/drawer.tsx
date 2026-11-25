import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export type DrawerProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
};

export function Drawer({ open, title, onClose, children, footer }: DrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-testid="drawer">
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/30"
        aria-label="Close drawer"
        onClick={onClose}
      />
      <aside
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 id="drawer-title" className="text-base font-semibold">
            {title}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="border-t px-4 py-3">{footer}</div>
        ) : null}
      </aside>
    </div>
  );
}
