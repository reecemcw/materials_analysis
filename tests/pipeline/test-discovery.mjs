/**
 * test-discovery.mjs
 *
 * Standalone test runner for the discovery service.
 * Run from the project root:
 *
 *   node tests/test-discovery.mjs
 *   node tests/test-discovery.mjs --dry-run   # discover but don't write to url.json
 *   node tests/test-discovery.mjs --source "Rare Earth Exchanges"
 */

import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { discoverFromFeed, discoverFromSitemap, autoDiscover } from "../../services/discovery/src/url_discoverer.js";
import { runDiscovery } from "../../services/discovery/src/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args    = process.argv.slice(2);
const dryRun  = args.includes("--dry-run");
const srcFilter = args.includes("--source")
  ? args[args.indexOf("--source") + 1]
  : null;

console.log("\n=== Discovery Test Runner ===");
if (dryRun) console.log("DRY RUN — url.json will not be modified\n");

// Temporarily patch mergeDiscovered in dry-run mode
if (dryRun) {
  process.env.DISCOVERY_DRY_RUN = "1";
}

const sourcesRaw = await readFile(join(__dirname, "../../services/discovery/src/sources.json"), "utf8");
let { sources }  = JSON.parse(sourcesRaw);

if (srcFilter) {
  sources = sources.filter(s => s.name.toLowerCase().includes(srcFilter.toLowerCase()));
  console.log("Filtered to sources matching: " + srcFilter);
  console.log("Matched: " + sources.map(s => s.name).join(", ") + "\n");
}

if (sources.length === 0) {
  console.error("No matching sources found.");
  process.exit(1);
}

// Quick sanity check — test auto-discover on first source
const first = sources[0];
console.log("Auto-discovering from: " + first.baseUrl);
const discovered = await autoDiscover(first.baseUrl);
console.log("  Feeds found:    ", discovered.feeds);
console.log("  Sitemaps found: ", discovered.sitemaps, "\n");

// Run full discovery
const report = await runDiscovery(sources);

console.log("\n=== Summary ===");
console.log("Sources run:      ", report.sourcesRun);
console.log("Total discovered: ", report.totalDiscovered);
console.log("Added to registry:", report.totalAdded);
console.log("Already existed:  ", report.totalSkipped);
console.log("Errors:           ", report.totalErrors);
console.log("");

for (const src of report.sources) {
  const icon = src.errors.length > 0 ? "?" : src.added > 0 ? "?" : "?";
  console.log(icon + " " + src.name + ": discovered=" + src.discovered + " added=" + src.added + " skipped=" + src.skipped + (src.errors.length ? " errors=" + src.errors.length : ""));
  for (const err of src.errors) {
    console.log("   ERROR: " + err);
  }
}

console.log("\n=== Done ===\n");
