// Mirrors engine/src/pre_engine/config.py COMPONENTS keys, which the
// planform hotspot geometry (geometry.ts) is keyed by.
export const PART_NUMBER_TO_KEY: Record<string, string> = {
  "21-1005-01": "ECS-COOL",
  "24-2110-01": "GEN-MAIN",
  "24-2240-02": "BATT-MAIN",
  "25-6410-01": "CADPAD",
  "27-3310-04": "STAB-ACT",
  "27-3550-01": "FCC",
  "28-2210-02": "FUEL-BOOST",
  "29-1140-03": "HYD-PUMP",
  "32-1120-05": "MLG",
  "32-4210-02": "BRAKE",
  "32-4310-01": "TYRE",
  "34-4410-02": "RADALT",
  "34-1810-01": "INU",
  "49-1210-01": "JFS",
  "72-0001-10": "ENGINE",
  "72-5120-01": "HPT",
  "73-2110-01": "FCU",
  "79-1310-02": "OIL-PUMP",
};

export function planformKeyFor(partNumber: string, position: string): string {
  const key = PART_NUMBER_TO_KEY[partNumber] ?? partNumber;
  return position === "L" || position === "R" ? `${key}-${position}` : key;
}
