import { cn } from "../../lib/utils.js";

export function Label({ className, ...props }) {
  return (
    <label
      data-slot="label"
      className={cn("flex flex-col gap-1 text-sm font-medium text-neutral-900", className)}
      {...props}
    />
  );
}
