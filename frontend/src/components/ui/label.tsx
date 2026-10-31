import type { LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn("flex flex-col gap-1 text-sm font-medium text-neutral-900", className)}
      {...props}
    />
  );
}
