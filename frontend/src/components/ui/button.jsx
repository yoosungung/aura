import { cn } from "../../lib/utils.js";

export function Button({ className, type = "button", ...props }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
