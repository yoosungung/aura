import { cn } from "../../lib/utils.js";

export function Input({ className, type = "text", ...props }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none focus-visible:border-neutral-900",
        className,
      )}
      {...props}
    />
  );
}
