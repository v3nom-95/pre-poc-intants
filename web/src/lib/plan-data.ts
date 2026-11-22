import fs from "fs";
import path from "path";
import type { PlanData } from "./plan-types";

const PLAN_PATH = path.join(process.cwd(), "public", "data", "plan.json");

export function getPlan(): PlanData {
  return JSON.parse(fs.readFileSync(PLAN_PATH, "utf-8")) as PlanData;
}
