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
