import { loadAndValidateCatalog } from "./catalog-lib.js";

const catalogPath = process.argv[2] ?? "catalog/targets.json";
const result = await loadAndValidateCatalog(process.cwd(), catalogPath);

if (!result.ok) {
  console.error("Catalog validation failed:");
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  `ok: validated ${result.catalog.targets.length} catalog target(s) from ${catalogPath}`,
);
