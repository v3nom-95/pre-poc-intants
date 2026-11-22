const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatDate(d: Date | string): string {
  // Date-only ISO strings ("2026-11-15") parse as UTC midnight; reading them
  // with local getters shifts the day back for any viewer west of UTC, so we
  // always read UTC fields rather than local ones.
  const date = typeof d === "string" ? new Date(d) : d;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatFH(n: number, decimals = 0): string {
  return `${formatNumber(n, decimals)} FH`;
}

export function formatPct(n: number, decimals = 0): string {
  return `${formatNumber(n, decimals)}%`;
}

/** "2026-11" to "Nov 2026". */
export function formatMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return `${MONTHS[m - 1]} ${y}`;
}

/** Remaining life on a hard-time item with the unit of its governing limit.
 * Calendar remaining is exported in months (rules.py); the rest are counts. */
export function formatRemaining(remaining: number, governing: string | null): string {
  switch (governing) {
    case "Calendar":
      return remaining < 1
        ? `${formatNumber(remaining * 30.44, 0)} days`
        : `${formatNumber(remaining, 1)} months`;
    case "FH":
      return `${formatNumber(remaining, 0)} FH`;
    case "EFH":
      return `${formatNumber(remaining, 0)} EFH`;
    case "Cycles":
      return `${formatNumber(remaining, 0)} LCF cycles`;
    case "Landings":
      return `${formatNumber(remaining, 0)} landings`;
    case "APU hours":
      return `${formatNumber(remaining, 0)} APU hours`;
    default:
      return `${formatNumber(remaining, 1)}${governing ? ` ${governing}` : ""}`;
  }
}

/** Rewrite ISO dates embedded in exported text ("Replace by 2027-04-02") as "2 Apr 2027". */
export function formatIsoDatesInText(text: string): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y, mo, d) => `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`);
}
