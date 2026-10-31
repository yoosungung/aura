import type { TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus-visible:border-neutral-900",
        className,
      )}
      {...props}
    />
  );
}
