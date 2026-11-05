#!/usr/bin/env node
/**
 * Rebuilds the alias maps the v2 server uses to normalize names:
 *   src/data/molecular_profile_map.json
 *   src/data/disease_name_map.json
 *   src/data/therapy_name_map.json
 *
 * Port of the notebook code that produced them (MCP_test_7_3.ipynb cells 11, 20
 * and 36, then MCP_MP_n_gram.ipynb cell 10), plus the "<a>::<b> fusion" aliases
 * added to fusion profiles in April 2026. One deliberate change: the notebook
 * skipped every disease whose DOID was missing from terms_cancers.tsv (162
 * diseases, including "Cancer"); those are now kept, with CIViC and Disease
 * Ontology synonyms only.
 *
 * Sources: CIViC GraphQL API, the Disease Ontology (doid.obo) and
 * src/data/terms_cancers.tsv (BioWordlists; not bundled into the worker).
 *
 * Usage: node scripts/refresh-alias-maps.mjs [--out <dir>] [--tsv <file>]
 * Needs Node 18+. Writes nothing if any download fails or a map loses more
 * than 10% of its keys. Run daily by .github/workflows/refresh-alias-maps.yml.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : fallback;
};
const OUT_DIR = argValue("--out", path.join(repoRoot, "src/data"));
const TSV_PATH = argValue("--tsv", path.join(repoRoot, "src/data/terms_cancers.tsv"));

const CIVIC_URL = "https://civicdb.org/api/graphql";
const DOID_OBO_URL = "http://purl.obolibrary.org/obo/doid.obo";
const MAX_SHRINK = 0.1; // refuse to write a map that loses more than 10% of its keys

let requestCount = 0;

async function fetchWithRetry(url, init, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    requestCount++;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} from ${url}`);
      if (attempt >= attempts) throw new Error(`HTTP ${res.status} from ${url} after ${attempts} attempts`);
    } catch (err) {
      if (attempt >= attempts || /^HTTP 4/.test(err.message)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function gql(query, variables) {
  const res = await fetchWithRetry(CIVIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "civic-mcp-server alias refresh" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(`CIViC GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
}

/** Yields each page of a CIViC connection, in CIViC's default (id) order. */
async function* pages(connection, nodeFields) {
  const query = `query($after: String) { ${connection}(after: $after) { pageInfo { hasNextPage endCursor } nodes { ${nodeFields} } } }`;
  let after = null;
  for (;;) {
    const data = (await gql(query, { after }))[connection];
    yield data.nodes;
    if (!data.pageInfo.hasNextPage) return;
    after = data.pageInfo.endCursor;
  }
}

const lower = (s) => s.toLowerCase();

// ---------- Disease Ontology (same terms as obonet.read_obo with ignore_obsolete=True) ----------
function parseDoidObo(text) {
  const terms = new Map(); // "DOID:1234" -> { name, synonyms }
  for (const stanza of text.split(/\r?\n(?=\[)/)) {
    if (!stanza.startsWith("[Term]")) continue;
    let id;
    let name;
    let obsolete = false;
    const synonyms = [];
    for (const line of stanza.split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s?(.*)$/);
      if (!m) continue;
      const [, tag, value] = m;
      if (tag === "id") id = value.trim();
      else if (tag === "name") name = value.trim();
      else if (tag === "synonym") synonyms.push(value.trim());
      else if (tag === "is_obsolete" && value.trim() === "true") obsolete = true;
    }
    if (id && name && !obsolete) terms.set(id, { name, synonyms });
  }
  return terms;
}

/** Label plus quoted synonym text, like the notebook's doid_disease_synonyms(). */
function doidSynonyms(terms, doid) {
  const term = terms.get(`DOID:${doid}`);
  if (!term) return [];
  const synonyms = term.synonyms.map((s) => s.match(/^"(.+?)"/)?.[1]).filter((s) => s !== undefined);
  return [term.name, ...synonyms];
}

function parseTermsTsv(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split("\t");
  const iDoid = header.indexOf("doid");
  const iSyn = header.indexOf("syn");
  if (iDoid < 0 || iSyn < 0) throw new Error("terms_cancers.tsv needs 'doid' and 'syn' columns");
  const synByDoid = new Map();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!synByDoid.has(cols[iDoid])) synByDoid.set(cols[iDoid], cols[iSyn] ?? "");
  }
  return synByDoid;
}

// ---------- disease map (MCP_test_7_3.ipynb cell 11) ----------
async function buildDiseaseMap(tsv, doidTerms) {
  const map = {};
  for await (const nodes of pages("diseases", "displayName diseaseAliases doid")) {
    for (const node of nodes) {
      const displayName = node.displayName;
      if (displayName in map) continue;
      const aliases = new Set([lower(displayName)]);
      for (const alias of node.diseaseAliases) aliases.add(lower(alias));
      if (node.doid) {
        const syn = tsv.get(`DOID:${node.doid}`);
        if (syn) for (const s of syn.split("|")) aliases.add(lower(s));
        for (const s of doidSynonyms(doidTerms, node.doid)) aliases.add(lower(s));
      }
      map[lower(displayName)] = [...aliases];
    }
  }
  return map;
}

// ---------- therapy map (MCP_test_7_3.ipynb cell 20) ----------
async function buildTherapyMap() {
  const map = {};
  for await (const nodes of pages("therapies", "name therapyAliases")) {
    for (const node of nodes) {
      if (node.name in map) continue;
      const aliases = new Set([lower(node.name)]);
      for (const alias of node.therapyAliases) aliases.add(lower(alias));
      map[lower(node.name)] = [...aliases];
    }
  }
  return map;
}

// ---------- molecular profile map (cell 36 + MCP_MP_n_gram.ipynb cell 10 + fusion aliases) ----------
async function buildMolecularProfileMap() {
  const map = {};
  const fields = "variants { name variantAliases feature { name featureAliases } }";
  for await (const nodes of pages("molecularProfiles", fields)) {
    for (const node of nodes) {
      for (const variant of node.variants) {
        const gene = variant.feature.name;
        const geneAliases = [...new Set(variant.feature.featureAliases.map(lower))];
        map[lower(gene)] = geneAliases;
        if (gene.includes("::")) {
          // Fusions: keyed by the fusion gene, aliased by the variant's aliases.
          map[lower(gene)] = [...variant.variantAliases];
          continue;
        }
        const aliases = new Set();
        for (const g of geneAliases) for (const v of variant.variantAliases) aliases.add(lower(`${g} ${v}`));
        map[lower(`${gene} ${variant.name}`)] = [...aliases];
      }
    }
  }
  for (const key of Object.keys(map)) {
    const aliases = new Set([...map[key].map(lower), key]); // every key is also its own alias
    // "<a>::<b> fusion" for fusions whose partners are both named (not v or ?)
    if (key.includes("::") && !key.split("::").some((p) => p === "v" || p === "?")) aliases.add(`${key} fusion`);
    map[key] = [...aliases];
  }
  return map;
}

// ---------- output ----------
/**
 * Same layout as Python's json.dump(indent=4): non-ASCII escaped as \uXXXX.
 * Key order is kept (it decides which primary wins an alias collision in the
 * server); aliases are sorted so daily diffs only show real changes.
 */
function toJson(map) {
  const sorted = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));
  return (
    JSON.stringify(sorted, null, 4).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) +
    "\n"
  );
}

function compare(name, oldMap, newMap) {
  const oldKeys = Object.keys(oldMap ?? {});
  const added = Object.keys(newMap).filter((k) => !(k in (oldMap ?? {})));
  const removed = oldKeys.filter((k) => !(k in newMap));
  const changed = oldKeys.filter((k) => {
    if (!(k in newMap)) return false;
    const a = new Set(oldMap[k]);
    return newMap[k].length !== a.size || newMap[k].some((x) => !a.has(x));
  });
  console.log(
    `${name}: ${oldKeys.length} -> ${Object.keys(newMap).length} keys ` +
      `(+${added.length} / -${removed.length}, ${changed.length} with changed aliases)`,
  );
  if (added.length) console.log(`  added: ${added.slice(0, 15).join(" | ")}${added.length > 15 ? " | ..." : ""}`);
  if (removed.length) console.log(`  removed: ${removed.slice(0, 15).join(" | ")}${removed.length > 15 ? " | ..." : ""}`);
  return oldKeys.length > 0 && Object.keys(newMap).length < oldKeys.length * (1 - MAX_SHRINK);
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

async function main() {
  const started = Date.now();
  const tsv = parseTermsTsv(fs.readFileSync(TSV_PATH, "utf8"));
  const doidTerms = parseDoidObo(await (await fetchWithRetry(DOID_OBO_URL, {})).text());
  if (doidTerms.size < 5000) throw new Error(`doid.obo looks incomplete (${doidTerms.size} terms)`);

  const maps = {
    "molecular_profile_map.json": await buildMolecularProfileMap(),
    "disease_name_map.json": await buildDiseaseMap(tsv, doidTerms),
    "therapy_name_map.json": await buildTherapyMap(),
  };
  console.log(`Fetched in ${((Date.now() - started) / 1000).toFixed(0)} s with ${requestCount} requests\n`);

  const tooSmall = [];
  for (const [file, map] of Object.entries(maps)) {
    if (compare(file, readJson(path.join(OUT_DIR, file)), map)) tooSmall.push(file);
  }
  if (tooSmall.length) {
    throw new Error(`Not writing anything: ${tooSmall.join(", ")} lost more than ${MAX_SHRINK * 100}% of keys`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, map] of Object.entries(maps)) fs.writeFileSync(path.join(OUT_DIR, file), toJson(map));
  console.log(`\nWrote ${Object.keys(maps).length} maps to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
