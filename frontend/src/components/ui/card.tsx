import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: DivProps) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 p-6 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 data-slot="card-title" className={cn("text-xl font-semibold", className)} {...props} />;
}

export function CardContent({ className, ...props }: DivProps) {
  return <div data-slot="card-content" className={cn("p-6 pt-2", className)} {...props} />;
}
