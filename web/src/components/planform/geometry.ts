import { line as d3line, curveCatmullRomClosed } from "d3-shape";

export const VIEWBOX = { w: 600, h: 1000 };
export const CENTERLINE_X = 300;

// Right-half outline points given by SPEC 7.4, nose at top.
const RIGHT_POINTS: [number, number][] = [
  [300, 40],
  [312, 110],
  [322, 200],
  [330, 300],
  [334, 340],
  [380, 420],
  [398, 470],
  [560, 600],
  [560, 640],
  [402, 660],
  [346, 690],
  [346, 800],
  [470, 880],
  [470, 905],
  [350, 915],
  [336, 950],
  [318, 962],
  [300, 962],
];

const LEFT_POINTS: [number, number][] = RIGHT_POINTS.slice(0, -1)
  .reverse()
  .map(([x, y]) => [600 - x, y]);

export const OUTLINE_POINTS: [number, number][] = [...RIGHT_POINTS, ...LEFT_POINTS];

const outlineGen = d3line<[number, number]>()
  .x((p) => p[0])
  .y((p) => p[1])
  .curve(curveCatmullRomClosed.alpha(0.6));

export const OUTLINE_PATH = outlineGen(OUTLINE_POINTS) ?? "";

export const CANOPY = { cx: 300, cy: 235, rx: 14, ry: 46 };
export const VERTICAL_TAIL = { x: 297, y: 780, width: 6, height: 170, rx: 3 };

export const STATION_LINES = [100, 200, 300, 400, 500, 600, 700, 800, 900];
export const BUTT_LINES = [-200, -100, 100, 200];
export const ZONE_BOUNDARIES_Y = [380, 500, 700];

export interface Hotspot {
  id: string;
  label: string;
  x: number;
  y: number;
  componentKeys: string[];
}

export const HOTSPOTS: Hotspot[] = [
  { id: "cockpit", label: "Cockpit and avionics bay", x: 300, y: 300, componentKeys: ["FCC", "INU", "BATT-MAIN", "CADPAD"] },
  { id: "fwd-underside", label: "Forward fuselage underside", x: 300, y: 560, componentKeys: ["RADALT"] },
  { id: "centre-fuselage", label: "Centre fuselage", x: 300, y: 450, componentKeys: ["ECS-COOL", "FUEL-BOOST"] },
  { id: "mlg-left", label: "Left main gear", x: 240, y: 640, componentKeys: ["MLG-L", "BRAKE-L", "TYRE-L"] },
  { id: "mlg-right", label: "Right main gear", x: 360, y: 640, componentKeys: ["MLG-R", "BRAKE-R", "TYRE-R"] },
  {
    id: "engine-bay",
    label: "Engine bay",
    x: 300,
    y: 780,
    componentKeys: ["ENGINE", "HPT", "FCU", "OIL-PUMP", "JFS", "GEN-MAIN", "HYD-PUMP"],
  },
  { id: "stab-left", label: "Left stabilator", x: 230, y: 880, componentKeys: ["STAB-ACT-L"] },
  { id: "stab-right", label: "Right stabilator", x: 370, y: 880, componentKeys: ["STAB-ACT-R"] },
];
