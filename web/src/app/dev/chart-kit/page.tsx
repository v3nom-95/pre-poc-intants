"use client";

import { AppShell } from "@/components/shell/app-shell";
import { StatusTag, PriorityTag } from "@/components/domain/status-tag";
import { TailNumber } from "@/components/domain/tail-number";
import { ChartFrame, ChartLegend } from "@/components/charts/chart-frame";
import { LineChart } from "@/components/charts/line-chart";
import { StackedBarChart } from "@/components/charts/stacked-bar-chart";
import { RankedBarChart } from "@/components/charts/ranked-bar-chart";
import { DotPlot } from "@/components/charts/dot-plot";
import { ChartTable } from "@/components/charts/chart-table";
import { JetPlanform } from "@/components/planform/jet-planform";
import { FlightLinePlanform } from "@/components/planform/flight-line-planform";
import { PlanformDrawing, type ZoneComponentMap } from "@/components/planform/planform-drawing";
import { PLANFORM_GEOMETRY, PLANFORM_TYPE_NAME } from "@/components/planform/type-geometry";
import { CHART_CATEGORICAL, type Priority, type Status } from "@/lib/domain-types";
import { formatFH, formatPct } from "@/lib/format";

const STATUSES: Status[] = ["Serviceable", "Monitor", "Action due", "Critical"];
const PRIORITIES: Priority[] = ["Critical", "High", "Medium", "Low"];

const UTIL_SERIES = [
  {
    id: "base-a",
    label: "Base A",
    color: CHART_CATEGORICAL[0],
    points: Array.from({ length: 24 }, (_, i) => ({ x: i, y: 140 + 20 * Math.sin(i / 2) + (i % 7) * 3 })),
  },
  {
    id: "base-b",
    label: "Base B",
    color: CHART_CATEGORICAL[1],
    points: Array.from({ length: 24 }, (_, i) => ({ x: i, y: 90 + 15 * Math.cos(i / 3) + (i % 5) * 2 })),
  },
];

const EGT_SERIES = [
  {
    id: "egt",
    label: "EGT margin",
    color: CHART_CATEGORICAL[2],
    points: Array.from({ length: 20 }, (_, i) => ({
      x: i * 15,
      y: 40 - i * 1.4,
      yLow: 40 - i * 1.4 - 3,
      yHigh: 40 - i * 1.4 + 3,
    })),
  },
];

const MISSION_MIX = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((m, i) => ({
  category: m,
  segments: [
    { key: "acm", value: 10 + (i % 3) * 2, color: CHART_CATEGORICAL[0], label: "ACM" },
    { key: "gat", value: 8 + (i % 2) * 3, color: CHART_CATEGORICAL[1], label: "Ground attack" },
    { key: "gen", value: 6, color: CHART_CATEGORICAL[3], label: "General flying" },
  ],
}));

const SNAGS_BY_ATA = [
  { label: "ATA 34 (Avionics)", value: 86 },
  { label: "ATA 32 (Landing gear)", value: 64 },
  { label: "ATA 29 (Hydraulics)", value: 41 },
  { label: "ATA 72 (Engine)", value: 29 },
  { label: "ATA 21 (ECS)", value: 18 },
].map((d, i) => ({ ...d, color: CHART_CATEGORICAL[i % CHART_CATEGORICAL.length] }));

const MTBF_DOTS = [
  { label: "Hydraulic pump", value: 1900, yLow: 1600, yHigh: 2300 },
  { label: "Fuel boost pump", value: 2200, yLow: 1900, yHigh: 2600 },
  { label: "Radar altimeter", value: 3500, yLow: 2800, yHigh: 4100 },
].map((d, i) => ({ ...d, color: CHART_CATEGORICAL[i] }));

const MOCK_COMPONENT_STATUS = {
  "FCC": { label: "Flight control computer", status: "Serviceable" as Status },
  "INU": { label: "Inertial navigation unit", status: "Serviceable" as Status },
  "BATT-MAIN": { label: "Main battery", status: "Monitor" as Status },
  "CADPAD": { label: "Ejection seat CAD/PAD set", status: "Action due" as Status },
  "RADALT": { label: "Radar altimeter", status: "Critical" as Status },
  "ECS-COOL": { label: "ECS cooling turbine", status: "Monitor" as Status },
  "FUEL-BOOST": { label: "Fuel boost pump", status: "Serviceable" as Status },
  "MLG-L": { label: "Main landing gear (left)", status: "Action due" as Status },
  "BRAKE-L": { label: "Main wheel brake (left)", status: "Serviceable" as Status },
  "TYRE-L": { label: "Main wheel tyre (left)", status: "Serviceable" as Status },
  "MLG-R": { label: "Main landing gear (right)", status: "Serviceable" as Status },
  "BRAKE-R": { label: "Main wheel brake (right)", status: "Serviceable" as Status },
  "TYRE-R": { label: "Main wheel tyre (right)", status: "Monitor" as Status },
  "ENGINE": { label: "Engine", status: "Critical" as Status },
  "HPT": { label: "HPT module", status: "Serviceable" as Status },
  "FCU": { label: "Engine fuel control unit", status: "Serviceable" as Status },
  "OIL-PUMP": { label: "Engine lube oil pump", status: "Monitor" as Status },
  "JFS": { label: "Jet fuel starter", status: "Serviceable" as Status },
  "GEN-MAIN": { label: "Main generator", status: "Serviceable" as Status },
  "HYD-PUMP": { label: "Engine-driven hydraulic pump", status: "Critical" as Status },
  "STAB-ACT-L": { label: "Stabilator actuator (left)", status: "Serviceable" as Status },
  "STAB-ACT-R": { label: "Stabilator actuator (right)", status: "Serviceable" as Status },
};

const FLEET_STATUSES: Status[] = Array.from({ length: 16 }, (_, i) =>
  STATUSES[i % STATUSES.length]
);

// Mock zone statuses for every planform type: cycle the four statuses over
// the type's zones so each marker color appears in the demo.
const MOCK_STATUS_CYCLE: Status[] = ["Serviceable", "Monitor", "Serviceable", "Action due", "Serviceable", "Critical"];

function mockZones(type: "fighter" | "transport" | "airlifter"): ZoneComponentMap {
  const zones: ZoneComponentMap = {};
  PLANFORM_GEOMETRY[type].hotspots.forEach((h, i) => {
    zones[h.id] = [{ key: `${type}-${h.id}`, label: `${h.label} unit`, status: MOCK_STATUS_CYCLE[i % MOCK_STATUS_CYCLE.length] }];
  });
  return zones;
}

const FLIGHT_LINE_GROUPS = [
  { type: "fighter" as const, tails: Array.from({ length: 8 }, (_, i) => `FX-${301 + i}`) },
  { type: "transport" as const, tails: Array.from({ length: 8 }, (_, i) => `TX-${401 + i}`) },
  { type: "airlifter" as const, tails: Array.from({ length: 6 }, (_, i) => `CX-${501 + i}`) },
];

export default function ChartKitDevPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-10 pb-16">
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Typography scale</h2>
          <div className="flex flex-col gap-2 rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            {[48, 36, 28, 22, 18, 15, 13, 12].map((px) => (
              <div key={px} style={{ fontSize: px }} className="text-(--ink)">
                PRE fleet overview {px}px
              </div>
            ))}
            <div className="mt-2 flex items-center gap-4">
              <TailNumber tail="FX-307" className="text-[28px] text-(--ink)" />
              <span className="tabular text-[13px] text-(--ink-2)">1,240 FH · 16 Nov 2026</span>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Status and priority tags</h2>
          <div className="flex flex-wrap gap-3 rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            {STATUSES.map((s) => (
              <StatusTag key={s} status={s} />
            ))}
            <span className="mx-2 h-6 w-px bg-(--rule)" />
            {PRIORITIES.map((p) => (
              <PriorityTag key={p} priority={p} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Planform, large interactive</h2>
          <div className="flex gap-6 rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <JetPlanform componentStatus={MOCK_COMPONENT_STATUS} className="h-[520px]" />
            <div className="flex flex-1 flex-col justify-center gap-2 text-[13px] text-(--ink-2)">
              <p>Click a hotspot to see component status. Station lines (FS) and butt lines (BL) are drawing conventions.</p>
              <p>Zone boundaries are dashed, per convention; chart gridlines are never dashed.</p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Planforms by aircraft type</h2>
          <div className="grid grid-cols-3 gap-4 rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            {(["fighter", "transport", "airlifter"] as const).map((type) => (
              <figure key={type} className="flex flex-col items-center gap-2">
                <PlanformDrawing type={type} zones={mockZones(type)} className="h-[440px] w-full" />
                <figcaption className="text-[13px] text-(--ink-2)">{PLANFORM_TYPE_NAME[type]}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Flight line by type</h2>
          <div className="flex flex-col gap-4 rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            {FLIGHT_LINE_GROUPS.map((group) => (
              <div key={group.type}>
                <p className="mb-2 text-[13px] font-semibold text-(--ink)">{PLANFORM_TYPE_NAME[group.type]}</p>
                <div className="grid grid-cols-8 gap-3">
                  {group.tails.map((tail, i) => (
                    <div key={tail} className="flex flex-col items-center gap-1">
                      <FlightLinePlanform
                        type={group.type}
                        status={FLEET_STATUSES[i % FLEET_STATUSES.length]}
                        animate
                        delayMs={i * 30}
                        className="h-20"
                      />
                      <TailNumber tail={tail} className="text-[11px] text-(--ink-2)" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Line chart with confidence band</h2>
          <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <ChartFrame
              title="Monthly utilisation by base"
              legend={<ChartLegend items={UTIL_SERIES.map((s) => ({ label: s.label, color: s.color }))} />}
              chart={<LineChart series={UTIL_SERIES} yTickFormat={(y) => formatFH(y)} xTickFormat={(x) => `M${x}`} />}
              table={
                <ChartTable
                  columns={["Month", ...UTIL_SERIES.map((s) => s.label)]}
                  rows={UTIL_SERIES[0].points.map((p, i) => [
                    `M${p.x}`,
                    ...UTIL_SERIES.map((s) => formatFH(s.points[i].y, 1)),
                  ])}
                />
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">EGT margin trend with interval</h2>
          <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <ChartFrame
              title="EGT margin over EFH since install"
              chart={
                <LineChart
                  series={EGT_SERIES}
                  yTickFormat={(y) => `${y.toFixed(0)}°C`}
                  xTickFormat={(x) => `${x} EFH`}
                  markers={[{ x: 240, label: "Now", color: "var(--ink-3)" }]}
                />
              }
              table={
                <ChartTable
                  columns={["EFH", "Margin (°C)", "Low", "High"]}
                  rows={EGT_SERIES[0].points.map((p) => [p.x, p.y.toFixed(1), p.yLow!.toFixed(1), p.yHigh!.toFixed(1)])}
                />
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Stacked bar: mission mix</h2>
          <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <ChartFrame
              title="Sorties by mission type"
              legend={<ChartLegend items={MISSION_MIX[0].segments.map((s) => ({ label: s.label, color: s.color }))} />}
              chart={<StackedBarChart data={MISSION_MIX} />}
              table={
                <ChartTable
                  columns={["Month", ...MISSION_MIX[0].segments.map((s) => s.label)]}
                  rows={MISSION_MIX.map((d) => [d.category, ...d.segments.map((s) => s.value)])}
                />
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Ranked horizontal bars</h2>
          <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <ChartFrame
              title="Snags by ATA chapter"
              chart={<RankedBarChart data={SNAGS_BY_ATA} showCumulativeShare valueFormat={(v) => String(v)} />}
              table={
                <ChartTable
                  columns={["ATA chapter", "Snags"]}
                  rows={SNAGS_BY_ATA.map((d) => [d.label, d.value])}
                />
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Dot plot with interval</h2>
          <div className="rounded-[8px] border border-(--rule) bg-(--sheet) p-5">
            <ChartFrame
              title="MTBF by part number"
              chart={<DotPlot data={MTBF_DOTS} valueFormat={(v) => formatFH(v)} />}
              table={
                <ChartTable
                  columns={["Part number", "MTBF", "Low", "High"]}
                  rows={MTBF_DOTS.map((d) => [d.label, formatFH(d.value), formatFH(d.yLow!), formatFH(d.yHigh!)])}
                />
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-(--ink)">Numbers and formatting</h2>
          <div className="flex flex-wrap gap-6 rounded-[8px] border border-(--rule) bg-(--sheet) p-5 text-[13px] text-(--ink)">
            <span className="tabular">{formatFH(1240.4, 1)}</span>
            <span className="tabular">{formatPct(58.3, 1)}</span>
            <span className="tabular">16 Nov 2026</span>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
