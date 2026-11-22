import fs from "fs";
import path from "path";
import type { WhatifData, WhatifInputs, Scenario } from "./whatif-types";

/** Reads web/public/data/whatif.json at build time (server only). */
export function getWhatif(): WhatifData {
  const full = path.join(process.cwd(), "public", "data", "whatif.json");
  return JSON.parse(fs.readFileSync(full, "utf-8")) as WhatifData;
}

/** Model inputs for the browser, without the parity fixtures (tests only). */
export function getWhatifInputs(): { inputs: WhatifInputs; defaultScenario: Scenario } {
  const data = getWhatif();
  const { parity_fixtures: _fixtures, default_scenario, ...inputs } = data;
  void _fixtures;
  return { inputs, defaultScenario: default_scenario };
}
