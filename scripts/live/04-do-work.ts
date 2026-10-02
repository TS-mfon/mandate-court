// Step 4: the provider agent does the work.
//
// Collects real earthquake records from the USGS FDSN event service, which is a
// public .gov endpoint requiring no key, and writes the three deliverables the
// mandate's acceptance criteria name. Nothing here is synthesised: every record
// and every source URL comes from the response, and the README records the
// exact query so a reviewer can re-run it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentRunId, log, RUNS_DIR, saveState } from "./lib";

const QUERY = new URLSearchParams({
  format: "geojson",
  starttime: "2026-09-01",
  endtime: "2026-09-30",
  minmagnitude: "5.0",
  orderby: "magnitude",
  limit: "50",
});
const ENDPOINT = `https://earthquake.usgs.gov/fdsnws/event/1/query?${QUERY}`;

type Feature = {
  id: string;
  properties: { place: string | null; mag: number | null; time: number | null; url: string | null; magType: string | null; status: string | null };
  geometry: { coordinates: [number, number, number] | null };
};

async function main() {
  const runId = currentRunId();
  const outDir = join(RUNS_DIR, runId, "deliverable");
  mkdirSync(outDir, { recursive: true });

  log(`querying ${ENDPOINT}`);
  const response = await fetch(ENDPOINT, { headers: { accept: "application/geojson" } });
  if (!response.ok) throw new Error(`USGS returned HTTP ${response.status}`);
  const collection = (await response.json()) as { features: Feature[]; metadata?: { count?: number; generated?: number } };
  log(`USGS returned ${collection.features.length} features`);

  // Keep only records where every required field is genuinely present. A
  // record with a null field would fail C1, and padding it would be a lie.
  const records: Array<Record<string, unknown>> = [];
  const sources: Array<Record<string, unknown>> = [];
  let dropped = 0;
  for (const feature of collection.features) {
    const { place, mag, time, url } = feature.properties;
    const coords = feature.geometry?.coordinates;
    if (!feature.id || !place || mag === null || mag === undefined || !time || !coords || coords.length < 3) {
      dropped += 1;
      continue;
    }
    const [longitude, latitude, depthKm] = coords;
    if (longitude === null || latitude === null || depthKm === null) {
      dropped += 1;
      continue;
    }
    records.push({
      event_id: feature.id,
      place,
      magnitude: mag,
      occurred_at: new Date(time).toISOString(),
      depth_km: depthKm,
      coordinates: { longitude, latitude },
      magnitude_type: feature.properties.magType ?? null,
      review_status: feature.properties.status ?? null,
    });
    if (!url) throw new Error(`USGS feature ${feature.id} has no event URL; C2 cannot be satisfied honestly`);
    sources.push({ event_id: feature.id, source_url: url, source: "USGS Earthquake Hazards Program", retrieved_at: new Date().toISOString() });
  }

  log(`kept ${records.length} records, dropped ${dropped} with an incomplete required field`);
  if (records.length < 40) throw new Error(`only ${records.length} complete records; C1 requires at least 40. Widen the query rather than padding.`);

  const offDomain = sources.filter((s) => !String(s.source_url).startsWith("https://earthquake.usgs.gov/"));
  if (offDomain.length) throw new Error(`${offDomain.length} source URLs are not on earthquake.usgs.gov; C2 would fail`);

  const collectedAt = new Date().toISOString();
  const readme = `# Recent Significant Earthquake Records (USGS)

A dataset of ${records.length} earthquake events collected from the USGS Earthquake Hazards Program
public catalog, with a resolvable primary source URL for every record.

## Collection date

${collectedAt}

## Source catalog and exact query

All records come from the USGS FDSN event web service. The exact request used was:

\`\`\`
${ENDPOINT}
\`\`\`

Parameters: events between ${QUERY.get("starttime")} and ${QUERY.get("endtime")} (UTC) with a
magnitude of at least ${QUERY.get("minmagnitude")}, ordered by magnitude, capped at
${QUERY.get("limit")} results. The service returned ${collection.features.length} features;
${dropped} were discarded because at least one required field was null, leaving ${records.length}
complete records. No value in this dataset was inferred, interpolated, or substituted.

Service documentation: https://earthquake.usgs.gov/fdsnws/event/1/

## Files

| File | Contents |
| --- | --- |
| \`results.json\` | ${records.length} earthquake records, one object per event |
| \`sources.json\` | One entry per \`event_id\`, giving its USGS event page URL |
| \`README.md\` | This file |

## Fields in results.json and their units

| Field | Type | Unit / format |
| --- | --- | --- |
| \`event_id\` | string | USGS event identifier, unique within the catalog |
| \`place\` | string | Human-readable location as published by USGS |
| \`magnitude\` | number | Magnitude on the scale given by \`magnitude_type\`, dimensionless |
| \`occurred_at\` | string | Event origin time, ISO-8601 in UTC |
| \`depth_km\` | number | Depth below sea level, kilometres |
| \`coordinates.longitude\` | number | Decimal degrees, WGS 84, east positive, range -180 to 180 |
| \`coordinates.latitude\` | number | Decimal degrees, WGS 84, north positive, range -90 to 90 |
| \`magnitude_type\` | string | Magnitude scale used by USGS for this event, e.g. mww, mb |
| \`review_status\` | string | USGS review state, \`reviewed\` or \`automatic\` |

\`magnitude\` is dimensionless by definition; it is a logarithmic scale value, not a measurement in
physical units. \`depth_km\` is positive downward.

## Verifying this dataset

Every record can be re-checked against the authoritative catalog:

\`\`\`bash
jq -r '.records[0].event_id' results.json
jq -r '.sources[] | select(.event_id == "<event_id>") | .source_url' sources.json
\`\`\`

Opening that URL shows the USGS event page for the same event. Re-running the query above returns
the same events, though USGS may revise a magnitude or review status after publication, which is why
\`retrieved_at\` is recorded per source.

## Licence and attribution

USGS earthquake data is in the public domain. Produced for Mandate Court mandate
\`${process.env.MANDATE_ID ?? "(see delivery manifest)"}\`.
`;

  const resultsJson = `${JSON.stringify({ generated_at: collectedAt, source: "USGS Earthquake Hazards Program", query: ENDPOINT, record_count: records.length, records }, null, 2)}\n`;
  const sourcesJson = `${JSON.stringify({ generated_at: collectedAt, entry_count: sources.length, sources }, null, 2)}\n`;

  writeFileSync(join(outDir, "results.json"), resultsJson);
  writeFileSync(join(outDir, "sources.json"), sourcesJson);
  writeFileSync(join(outDir, "README.md"), readme);

  log(`wrote 3 files to ${outDir}`);
  log(`results.json  ${resultsJson.length} bytes, ${records.length} records`);
  log(`sources.json  ${sourcesJson.length} bytes, ${sources.length} entries`);
  log(`README.md     ${readme.length} bytes`);

  saveState(runId, {
    deliverableDir: outDir,
    usgsQuery: ENDPOINT,
    recordCount: records.length,
    droppedCount: dropped,
    collectedAt,
  });
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
