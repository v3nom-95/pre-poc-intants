// Planform geometry per aircraft type (SPEC 7.4 and 14.1).
//
// Every drawing shares the same viewBox (600 x 1000, centreline x=300, nose
// at the top) and drawing conventions. The fighter keeps the SPEC 7.4
// outline; the transport and airlifter outlines are original, generic
// schematics built from a right-half path that is mirrored about the
// centreline. Hotspots are keyed by planform zone id (SPEC 14.1).
import {
  OUTLINE_PATH,
  CANOPY,
  VERTICAL_TAIL,
  STATION_LINES,
  BUTT_LINES,
  ZONE_BOUNDARIES_Y,
  HOTSPOTS,
  CENTERLINE_X,
} from "./geometry";

export type PlanformType = "fighter" | "transport" | "airlifter";

export const PLANFORM_TYPES: PlanformType[] = ["fighter", "transport", "airlifter"];

export const PLANFORM_TYPE_NAME: Record<PlanformType, string> = {
  fighter: "Multirole fighter",
  transport: "Twin-engine transport",
  airlifter: "Four-engine airlifter",
};

export interface ZoneHotspot {
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface PlanformGeometry {
  type: PlanformType;
  outlinePath: string;
  /** Extra drawing strokes: nacelles, propeller discs, wing or tailplane edges over the fuselage, ramp. */
  details: string[];
  canopy?: { cx: number; cy: number; rx: number; ry: number };
  verticalTail: { x: number; y: number; width: number; height: number; rx: number };
  stationLines: number[];
  buttLines: number[];
  zoneBoundariesY: number[];
  hotspots: ZoneHotspot[];
}

type Pt = [number, number];
interface Seg {
  to: Pt;
  c?: Pt;
}

const mirror = ([x, y]: Pt): Pt => [2 * CENTERLINE_X - x, y];
const fmt = ([x, y]: Pt) => `${x},${y}`;

/** Closed outline from a right-half path (start on the centreline, end on the centreline). */
function mirroredOutline(start: Pt, right: Seg[]): string {
  const parts = [`M${fmt(start)}`];
  for (const s of right) parts.push(s.c ? `Q${fmt(s.c)} ${fmt(s.to)}` : `L${fmt(s.to)}`);
  // Walk the right half backwards, mirrored, to draw the left half.
  for (let i = right.length - 1; i >= 0; i--) {
    const from = i === 0 ? start : right[i - 1].to;
    const s = right[i];
    parts.push(s.c ? `Q${fmt(mirror(s.c))} ${fmt(mirror(from))}` : `L${fmt(mirror(from))}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/** A path and its mirror image about the centreline. */
function both(d: (m: (p: Pt) => Pt) => string): string[] {
  return [d((p) => p), d(mirror)];
}

function nacelle(cx: number, front: number, back: number, halfW: number) {
  return both(
    (m) =>
      `M${fmt(m([cx - halfW, front + 14]))} Q${fmt(m([cx, front - 4]))} ${fmt(m([cx + halfW, front + 14]))} ` +
      `L${fmt(m([cx + halfW + 1, back]))} Q${fmt(m([cx, back + 12]))} ${fmt(m([cx - halfW - 1, back]))} Z`
  );
}

function propDisc(cx: number, y: number, radius: number) {
  return both(
    (m) =>
      `M${fmt(m([cx - radius, y]))} L${fmt(m([cx + radius, y]))} ` +
      `M${fmt(m([cx - 5, y + 2]))} Q${fmt(m([cx, y - 8]))} ${fmt(m([cx + 5, y + 2]))}`
  );
}

// ---------------------------------------------------------------------------
// Fighter (SPEC 7.4, unchanged)
// ---------------------------------------------------------------------------
const FIGHTER: PlanformGeometry = {
  type: "fighter",
  outlinePath: OUTLINE_PATH,
  details: [],
  canopy: CANOPY,
  verticalTail: VERTICAL_TAIL,
  stationLines: STATION_LINES,
  buttLines: BUTT_LINES,
  zoneBoundariesY: ZONE_BOUNDARIES_Y,
  hotspots: HOTSPOTS.map(({ id, label, x, y }) => ({ id, label, x, y })),
};

// ---------------------------------------------------------------------------
// Twin-engine transport: low wing, so the fuselage sides run unbroken over
// the wing root. Two wing-mounted turboprop nacelles, conventional tail.
// ---------------------------------------------------------------------------
const TRANSPORT: PlanformGeometry = {
  type: "transport",
  outlinePath: mirroredOutline(
    [300, 40],
    [
      { c: [332, 44], to: [336, 118] },
      { to: [336, 400] },
      { to: [565, 426] },
      { c: [575, 449], to: [565, 472] },
      { to: [336, 495] },
      { to: [336, 690] },
      { c: [336, 800], to: [318, 850] },
      { to: [440, 878] },
      { c: [447, 892], to: [440, 905] },
      { to: [314, 915] },
      { c: [307, 950], to: [300, 958] },
    ]
  ),
  details: [
    // Fuselage sides continue over the low wing root.
    ...both((m) => `M${fmt(m([336, 400]))} L${fmt(m([336, 495]))}`),
    // Flight deck windscreen.
    `M280,98 Q300,85 320,98`,
    ...nacelle(445, 336, 522, 13),
    ...propDisc(445, 332, 70),
  ],
  verticalTail: { x: 297, y: 800, width: 6, height: 155, rx: 3 },
  stationLines: STATION_LINES,
  buttLines: BUTT_LINES,
  zoneBoundariesY: [160, 370, 530, 820],
  hotspots: [
    { id: "cockpit", label: "Flight deck and avionics", x: 300, y: 112 },
    { id: "nose-gear", label: "Nose gear", x: 300, y: 192 },
    { id: "cabin", label: "Cabin and pressurisation", x: 300, y: 300 },
    { id: "centre-wing", label: "Centre wing and fuel", x: 300, y: 447 },
    { id: "engine-1", label: "Engine 1 (left)", x: 155, y: 440 },
    { id: "engine-2", label: "Engine 2 (right)", x: 445, y: 440 },
    { id: "mlg-left", label: "Left main gear", x: 220, y: 472 },
    { id: "mlg-right", label: "Right main gear", x: 380, y: 472 },
    { id: "tail", label: "Empennage and APU", x: 300, y: 880 },
  ],
};

// ---------------------------------------------------------------------------
// Four-engine airlifter: high wing, so the wing edges run unbroken over the
// fuselage. Wide fuselage, gear sponsons, rear cargo ramp, T-tail whose
// tailplane edges run over the fin.
// ---------------------------------------------------------------------------
const AIRLIFTER: PlanformGeometry = {
  type: "airlifter",
  outlinePath: mirroredOutline(
    [300, 38],
    [
      { c: [338, 42], to: [344, 120] },
      { to: [344, 360] },
      { to: [580, 384] },
      { c: [588, 404], to: [580, 424] },
      { to: [344, 452] },
      { to: [344, 700] },
      { c: [344, 800], to: [326, 850] },
      { to: [448, 880] },
      { c: [455, 895], to: [448, 910] },
      { to: [322, 922] },
      { c: [312, 960], to: [300, 968] },
    ]
  ),
  details: [
    // High wing: leading and trailing edges cross the fuselage.
    `M256,360 L344,360`,
    `M256,452 L344,452`,
    // T-tail: tailplane edges cross the fuselage over the fin.
    `M274,850 L326,850`,
    `M278,922 L322,922`,
    // Flight deck windscreen.
    `M276,90 Q300,76 324,90`,
    // Main gear sponsons.
    ...both((m) => `M${fmt(m([344, 505]))} Q${fmt(m([362, 510]))} ${fmt(m([362, 540]))} L${fmt(m([362, 590]))} Q${fmt(m([362, 615]))} ${fmt(m([344, 620]))}`),
    // Rear cargo ramp.
    `M278,690 L322,690 L318,800 L282,800 Z`,
    ...nacelle(420, 298, 468, 10),
    ...nacelle(510, 306, 458, 10),
    ...propDisc(420, 294, 40),
    ...propDisc(510, 302, 40),
  ],
  verticalTail: { x: 297, y: 790, width: 6, height: 70, rx: 3 },
  stationLines: STATION_LINES,
  buttLines: BUTT_LINES,
  zoneBoundariesY: [150, 330, 480, 680, 840],
  hotspots: [
    { id: "cockpit", label: "Flight deck and avionics", x: 300, y: 106 },
    { id: "nose-gear", label: "Nose gear", x: 300, y: 186 },
    { id: "cabin", label: "Cargo hold and pressurisation", x: 300, y: 285 },
    { id: "centre-wing", label: "Centre wing and fuel", x: 300, y: 406 },
    { id: "engine-1", label: "Engine 1 (left outboard)", x: 90, y: 400 },
    { id: "engine-2", label: "Engine 2 (left inboard)", x: 180, y: 396 },
    { id: "engine-3", label: "Engine 3 (right inboard)", x: 420, y: 396 },
    { id: "engine-4", label: "Engine 4 (right outboard)", x: 510, y: 400 },
    { id: "mlg-left", label: "Left main gear", x: 232, y: 562 },
    { id: "mlg-right", label: "Right main gear", x: 368, y: 562 },
    { id: "ramp", label: "Cargo ramp", x: 300, y: 745 },
    { id: "tail", label: "Empennage and APU", x: 300, y: 886 },
  ],
};

export const PLANFORM_GEOMETRY: Record<PlanformType, PlanformGeometry> = {
  fighter: FIGHTER,
  transport: TRANSPORT,
  airlifter: AIRLIFTER,
};

/**
 * Normalise whatever the data calls the type (key or display name) to a
 * planform type. Unknown or missing values fall back to the fighter, the
 * original single-type fleet.
 */
export function toPlanformType(value: string | null | undefined): PlanformType {
  const v = (value ?? "").toLowerCase();
  if (v.includes("airlift") || v.includes("cargo") || v.includes("four")) return "airlifter";
  if (v.includes("transport") || v.includes("twin") || v.includes("passenger")) return "transport";
  return "fighter";
}
