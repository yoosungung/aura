import { useState } from 'react';
import { shortId } from '@/lib/display';
import { cn } from '@/lib/utils';

type Props = {
  value: string;
  className?: string;
};

export function CopyableId({ value, className }: Props) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      title={value}
      onClick={copy}
      className={cn(
        'font-mono text-xs text-neutral-600 underline-offset-2 hover:underline',
        className
      )}
    >
      {copied ? 'copied' : shortId(value)}
    </button>
  );
}
