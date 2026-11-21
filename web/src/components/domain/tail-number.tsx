import { cn } from "@/lib/utils";

export function TailNumber({ tail, className }: { tail: string; className?: string }) {
  return <span className={cn("tail-number", className)}>{tail}</span>;
}
