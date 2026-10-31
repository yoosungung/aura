import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-neutral-900 text-white",
      secondary: "bg-neutral-100 text-neutral-900",
      outline: "border border-neutral-300 text-neutral-900",
      destructive: "border border-rose-200 bg-rose-50 text-rose-700",
    },
  },
  defaultVariants: { variant: "default" },
});

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
