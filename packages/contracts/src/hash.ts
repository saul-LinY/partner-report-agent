import { createHash } from "node:crypto";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

export function stableJsonHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}
