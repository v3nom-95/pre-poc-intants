"use client";

import { Check, Eye, TriangleAlert, OctagonAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STATUS_VAR, type Status } from "@/lib/domain-types";
import { StatusTag } from "@/components/domain/status-tag";
import type { ZoneHotspot } from "./type-geometry";

const STATUS_ICON = { Serviceable: Check, Monitor: Eye, "Action due": TriangleAlert, Critical: OctagonAlert };

export function HotspotMarker({
  hotspot,
  status,
  componentStatuses,
  onSelectComponent,
}: {
  hotspot: ZoneHotspot;
  status: Status;
  componentStatuses: { key: string; label: string; status: Status }[];
  onSelectComponent?: (key: string) => void;
}) {
  const Icon = STATUS_ICON[status];
  const color = STATUS_VAR[status];

  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        aria-label={`${hotspot.label}, status ${status}`}
        render={
          <g
            transform={`translate(${hotspot.x},${hotspot.y})`}
            className="cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-(--accent)"
          >
            <circle r={16} fill="transparent" />
            <circle r={9} fill={color} stroke="var(--sheet)" strokeWidth={2} />
            <foreignObject x={-7} y={-7} width={14} height={14} className="pointer-events-none">
              <Icon size={14} color="var(--sheet)" strokeWidth={2.5} />
            </foreignObject>
          </g>
        }
      />
      <PopoverContent side="right" className="w-64 rounded-[8px] border-(--rule) bg-(--sheet) p-3">
        <p className="mb-2 text-[12px] font-semibold text-(--ink)">{hotspot.label}</p>
        <ul className="flex flex-col gap-1.5">
          {componentStatuses.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => onSelectComponent?.(c.key)}
                className="flex w-full items-center justify-between gap-2 rounded-[6px] px-1.5 py-1 text-left text-[12px] text-(--ink) hover:bg-(--paper)"
              >
                <span>{c.label}</span>
                <StatusTag status={c.status} />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
