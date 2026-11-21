"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUiStore, type Role } from "@/lib/ui-store";

const ROLES: Role[] = ["Viewer", "Engineer", "Approver"];

export function RoleSwitcher() {
  const role = useUiStore((s) => s.role);
  const setRole = useUiStore((s) => s.setRole);

  return (
    <Select value={role} onValueChange={(v) => setRole(v as Role)}>
      <SelectTrigger size="sm" className="h-8 w-[112px] border-(--rule) bg-(--sheet) text-[12px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {ROLES.map((r) => (
          <SelectItem key={r} value={r} className="text-[13px]">
            {r}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
