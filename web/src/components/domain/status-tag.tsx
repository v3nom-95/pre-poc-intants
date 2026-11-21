import { Check, Eye, TriangleAlert, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRIORITY_VAR, STATUS_VAR, type Priority, type Status } from "@/lib/domain-types";

const STATUS_ICON: Record<Status, typeof Check> = {
  Serviceable: Check,
  Monitor: Eye,
  "Action due": TriangleAlert,
  Critical: OctagonAlert,
};

const PRIORITY_ICON: Record<Priority, typeof Check> = {
  Critical: OctagonAlert,
  High: TriangleAlert,
  Medium: Eye,
  Low: Check,
};

function Tag({
  label,
  color,
  Icon,
  className,
}: {
  label: string;
  color: string;
  Icon: typeof Check;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] border border-(--rule) bg-(--sheet) py-[3px] pl-[7px] pr-2 text-[12px] font-medium leading-none text-(--ink)",
        className
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Icon className="size-3" style={{ color }} strokeWidth={2.25} aria-hidden />
      {label}
    </span>
  );
}

export function StatusTag({ status, className }: { status: Status; className?: string }) {
  return (
    <Tag
      label={status}
      color={STATUS_VAR[status]}
      Icon={STATUS_ICON[status]}
      className={className}
    />
  );
}

export function PriorityTag({ priority, className }: { priority: Priority; className?: string }) {
  return (
    <Tag
      label={priority}
      color={PRIORITY_VAR[priority]}
      Icon={PRIORITY_ICON[priority]}
      className={className}
    />
  );
}
