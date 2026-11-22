import fs from "fs";
import path from "path";

/** One approved task card (SPEC 14.3), from the bundled bronze extract. */
export interface TaskCard {
  task_card: string;
  title: string;
  ata: string;
  applicable_types: string;
  task_type: string;
  standard_man_hours: number;
  elapsed_hours: number;
  interval: string;
  manual_reference: string;
}

// Minimal RFC 4180 reader: quoted fields may hold commas and doubled quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function getTaskCards(): Record<string, TaskCard> {
  const file = path.join(process.cwd(), "public", "data", "bronze", "maintenance_procedures.csv");
  if (!fs.existsSync(file)) return {};
  const [header, ...rows] = parseCsv(fs.readFileSync(file, "utf-8"));
  const idx = (name: string) => header.indexOf(name);
  const out: Record<string, TaskCard> = {};
  for (const r of rows) {
    const get = (name: string) => r[idx(name)] ?? "";
    const id = get("task_card");
    if (!id) continue;
    out[id] = {
      task_card: id,
      title: get("title"),
      ata: get("ata"),
      applicable_types: get("applicable_types"),
      task_type: get("task_type"),
      standard_man_hours: Number(get("standard_man_hours")),
      elapsed_hours: Number(get("elapsed_hours")),
      interval: get("interval"),
      manual_reference: get("manual_reference"),
    };
  }
  return out;
}
