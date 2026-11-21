export interface SeriesPoint {
  x: number | string;
  y: number;
  yLow?: number; // lower bound of confidence interval
  yHigh?: number; // upper bound of confidence interval
}

export interface Series {
  id: string;
  label: string;
  color: string;
  points: SeriesPoint[];
}

export interface StackedBarDatum {
  category: string | number;
  segments: { key: string; value: number; color: string; label: string }[];
}

export interface RankedBarDatum {
  label: string;
  value: number;
  color?: string;
}

export interface DotPlotDatum {
  label: string;
  value: number;
  yLow?: number;
  yHigh?: number;
  color?: string;
}

export const DEFAULT_LINE_COLOR = "var(--chart-cat-1)";
