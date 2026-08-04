import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  aggregationResultSchema,
  individualReportResultSchema,
  sessionContributionSchema,
  sessionExtractionResultSchema,
  teamReportResultSchema,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, "../../../plugins/partner-report/schemas");
const toJsonSchema = zodToJsonSchema as (
  schema: unknown,
  name: string,
) => unknown;

await mkdir(outputDir, { recursive: true });

const schemas = {
  "session-contribution-v1.json": toJsonSchema(
    sessionContributionSchema,
    "SessionContributionV1",
  ),
  "session-extraction-result-v1.json": toJsonSchema(
    sessionExtractionResultSchema,
    "SessionExtractionResultV1",
  ),
  "aggregation-result-v1.json": toJsonSchema(
    aggregationResultSchema,
    "AggregationResultV1",
  ),
  "individual-report-result-v1.json": toJsonSchema(
    individualReportResultSchema,
    "IndividualReportResultV1",
  ),
  "team-report-result-v1.json": toJsonSchema(
    teamReportResultSchema,
    "TeamReportResultV1",
  ),
};

for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(
    resolve(outputDir, name),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}

console.log(`Generated ${Object.keys(schemas).length} schemas in ${outputDir}`);
