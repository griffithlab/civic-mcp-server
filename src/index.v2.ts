// import gestaltSimilarity from "gestalt-pattern-matcher";

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// import { TfIdf, NGrams } from "natural";

import rawTherapyMap  from "./data/therapy_name_map.json";
import rawDiseaseMap  from "./data/disease_name_map.json";
import rawMPMap from "./data/molecular_profile_map.json";

//import rawGeneMap     from "./data/gene_name_map.json";

export const dTherapyMap: Record<string, string[]>  = rawTherapyMap  as Record<string, string[]>;
export const dDiseaseMap: Record<string, string[]>  = rawDiseaseMap  as Record<string, string[]>;
export const dMPMap:    Record<string, string[]>  = rawMPMap     as Record<string, string[]>;

import { findBestMatch } from 'string-similarity'

function normalizeStr(s: string): string {
  return s
    .normalize('NFKD')                   // decompose accents
    .replace(/[\u0300-\u036f]/g, '')     // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')        // keep only letters, digits, spaces
    .replace(/\s+/g, ' ')                // collapse runs of spaces
    .trim()
}

type AliasIndex = {
  aliasToPrimary: Record<string, string>;
  candidates: string[];
  primaryKeys: Set<string>;
  collisions?: Array<{ key: string; kept: string; dropped: string }>;
};

function buildAliasIndex(lookup: Record<string, string[]>): AliasIndex {
  const aliasToPrimary: Record<string, string> = {};
  const primaryKeys = new Set<string>();
  const collisions: AliasIndex["collisions"] = [];

  // Pass 1: primaries (authoritative)
  for (const primary of Object.keys(lookup)) {
    const k = normalizeStr(primary);
    aliasToPrimary[k] = primary;
    primaryKeys.add(k);
  }

  // Pass 2: aliases (cannot override primary keys; first-wins for collisions)
  for (const [primary, aliases] of Object.entries(lookup)) {
    for (const alias of aliases) {
      const k = normalizeStr(alias);

      // Never override an exact primary name mapping (e.g., "sorafenib")
      if (primaryKeys.has(k)) continue;

      const existing = aliasToPrimary[k];
      if (!existing) {
        aliasToPrimary[k] = primary;
      } else if (existing !== primary) {
        // Keep existing mapping; record collision for cleanup/debugging
        collisions?.push({ key: k, kept: existing, dropped: primary });
      }
    }
  }

  return { aliasToPrimary, candidates: Object.keys(aliasToPrimary), primaryKeys, collisions };
}

let MP_INDEX: AliasIndex | undefined;
let DISEASE_INDEX: AliasIndex | undefined;
let THERAPY_INDEX: AliasIndex | undefined;

function getMPIndex() {
  return (MP_INDEX ??= buildAliasIndex(dMPMap));
}
function getDiseaseIndex() {
  return (DISEASE_INDEX ??= buildAliasIndex(dDiseaseMap));
}
function getTherapyIndex() {
  return (THERAPY_INDEX ??= buildAliasIndex(dTherapyMap));
}

/** How a user-supplied name was mapped onto a CIViC name (reported back in every response). */
export type Resolution = {
  input: string;
  resolvedTo: string | null;
  match: "alias_exact" | "fuzzy" | "as_typed" | "not_recognized";
  score?: number; // similarity (0-1) for fuzzy matches
};

export function resolveEntity(
  name: string,
  index: AliasIndex,
  threshold = 0.7,
  opts?: {
    bypassBooleanOps?: boolean;   // if true, skip normalization when AND/OR/NOT present
    fallbackToOriginal?: boolean; // if true, return original if no good match
  }
): Resolution {
  // Don't normalize compound or negated MPs ("X AND Y", "NOT X"): fuzzy matching
  // would turn "NOT KIT D816V" into "kit d816v".
  if (opts?.bypassBooleanOps && /\b(?:AND|OR|NOT)\b/i.test(name)) {
    return { input: name, resolvedTo: name, match: "as_typed" };
  }

  const qNorm = normalizeStr(name);

  // exact match first (prevents fuzzy overriding an already-good key)
  const exact = index.aliasToPrimary[qNorm];
  if (exact) return { input: name, resolvedTo: exact, match: "alias_exact" };

  // fuzzy match second
  const { bestMatch } = findBestMatch(qNorm, index.candidates);
  if (bestMatch.rating >= threshold) {
    return {
      input: name,
      resolvedTo: index.aliasToPrimary[bestMatch.target],
      match: "fuzzy",
      score: Number(bestMatch.rating.toFixed(3)),
    };
  }

  return opts?.fallbackToOriginal
    ? { input: name, resolvedTo: name, match: "as_typed" }
    : { input: name, resolvedTo: null, match: "not_recognized" };
}

//export const dGeneMap:    Record<string, string[]>  = rawGeneMap     as Record<string, string[]>;

// import diseaseData from "./data/inverted_resolver_disease_500.json";
// import therapyData from "./data/inverted_resolver_therapy_500.json";
// import molecularData from "./data/inverted_resolver_molecular_500.json";

// /**
//  * Map a free‑form name to its primary alias via fuzzy matching.
//  *
//  * @param name      Input string (may be undefined or null)
//  * @param lookup    Record<primary, aliases[]>
//  * @param threshold Minimum similarity (0–1) to accept a match
//  * @returns         The matched primary string, or undefined if below threshold or name missing
//  */
// export function normalizeEntity(
//   name: string | undefined | null,
//   lookup: Record<string, string[]>,
//   threshold: number = 0.7
// ): string | undefined {
//   if (!name) {
//     return undefined
//   }

//   const qNorm = normalizeStr(name)

//   // Build a map from normalized‑alias → primary
//   const aliasToPrimary: Record<string, string> = {}
//   for (const [primary, aliases] of Object.entries(lookup)) {
//     aliasToPrimary[normalizeStr(primary)] = primary
//     for (const alias of aliases) {
//       aliasToPrimary[normalizeStr(alias)] = primary
//     }
//   }

//   const candidates = Object.keys(aliasToPrimary)
//   const { bestMatch } = findBestMatch(qNorm, candidates)

//   return bestMatch.rating >= threshold
//     ? aliasToPrimary[bestMatch.target]
//     : undefined
// }

function parseClinicalSignificance(value?: string): string | undefined {
  if (!value) return undefined;

  const idx = value.indexOf(": ");
  const term = idx === -1 ? value : value.slice(idx + 2);

  return term.toUpperCase();
}


/** -----------------------------------------------------------
 *  Helper: remove null / undefined properties from an object
 *  --------------------------------------------------------- */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null),
  ) as Partial<T>;          // ← assert the narrowed shape
}

// ========================================
// API CONFIGURATION - Customize for your GraphQL API
// ========================================

export const API_CONFIG = {
  name:        "CIViC_MCP",
  version:     "0.2.0",
  description: "Fixed‑schema MCP tools for the CIViC GraphQL API",
  mcpSpecVersion: "2025-06-18",
  features: {
    structuredToolOutput: true,
    metaFields:           true,
    protocolVersionHeaders: true,
    titleFields:          true,
    toolAnnotations:      true,
  },
  headers: {
    Accept:      "application/vnd.civicdb.v2+json",
    "User-Agent": "MCPCivicServer/0.2.0",
    "Content-Type": "application/json",
  },
} as const;

/** -----------------------------------------------------------------
 *  CIViC GraphQL client: 20 s timeout, one retry, typed errors
 *  ---------------------------------------------------------------- */
const CIVIC_GRAPHQL_URL = "https://civicdb.org/api/graphql";
const CIVIC_TIMEOUT_MS = 20_000;

type ToolErrorDetail = {
  type:
    | "UPSTREAM_TIMEOUT"
    | "UPSTREAM_NETWORK_ERROR"
    | "UPSTREAM_HTTP_ERROR"
    | "UPSTREAM_BAD_RESPONSE"
    | "GRAPHQL_ERROR"
    | "INTERNAL_ERROR";
  message: string;
  httpStatus?: number;
  retryable: boolean;
};

class CivicApiError extends Error {
  constructor(readonly detail: ToolErrorDetail) {
    super(detail.message);
  }
}

async function civicQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastError: ToolErrorDetail | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));

    let res: Response;
    try {
      res = await fetch(CIVIC_GRAPHQL_URL, {
        method: "POST",
        headers: API_CONFIG.headers,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(CIVIC_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      lastError = timedOut
        ? { type: "UPSTREAM_TIMEOUT", message: `The CIViC API did not respond within ${CIVIC_TIMEOUT_MS / 1000} s.`, retryable: true }
        : { type: "UPSTREAM_NETWORK_ERROR", message: `Could not reach the CIViC API: ${e instanceof Error ? e.message : String(e)}`, retryable: true };
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      const retryable = res.status >= 500 || res.status === 429;
      lastError = { type: "UPSTREAM_HTTP_ERROR", httpStatus: res.status, message: `The CIViC API returned HTTP ${res.status}.`, retryable };
      if (retryable) continue;
      break;
    }

    let body: { data?: T; errors?: Array<{ message?: string }> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      lastError = { type: "UPSTREAM_BAD_RESPONSE", httpStatus: res.status, message: "The CIViC API returned a response that is not JSON.", retryable: true };
      continue;
    }

    if (body.errors?.length || !body.data) {
      const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || "The CIViC API returned no data.";
      throw new CivicApiError({ type: "GRAPHQL_ERROR", message, retryable: false });
    }
    return body.data;
  }
  throw new CivicApiError(lastError ?? { type: "INTERNAL_ERROR", message: "Unknown error calling the CIViC API.", retryable: true });
}

function toolError(err: unknown, query?: unknown) {
  const error: ToolErrorDetail =
    err instanceof CivicApiError
      ? err.detail
      : { type: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err), retryable: false };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error, query }, null, 2) }],
  };
}

/** -----------------------------------------------------------------
 *  Molecular profile lookup (exact-name matching)
 *  ---------------------------------------------------------------- */
type ProfileRef = { id: number; name: string };

/** Case- and whitespace-insensitive form used to compare profile names. */
const canonName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

const resolveProfileName = (name: string) =>
  resolveEntity(name, getMPIndex(), 0.7, { bypassBooleanOps: true, fallbackToOriginal: true });

const PROFILE_SEARCH_QUERY = /* GraphQL */ `
  query molecularProfiles($name: String, $after: String) {
    molecularProfiles(name: $name, first: 300, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id name }
    }
  }`;

/** Profiles whose name contains `name` (CIViC's substring search). */
async function searchProfiles(name: string, maxPages = 4): Promise<{ totalCount: number; nodes: ProfileRef[] }> {
  type Page = {
    molecularProfiles: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ProfileRef[];
    };
  };
  const nodes: ProfileRef[] = [];
  let totalCount = 0;
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: Page = await civicQuery<Page>(PROFILE_SEARCH_QUERY, compact({ name, after }));
    totalCount = data.molecularProfiles.totalCount;
    nodes.push(...data.molecularProfiles.nodes);
    if (!data.molecularProfiles.pageInfo.hasNextPage) break;
    after = data.molecularProfiles.pageInfo.endCursor;
  }
  return { totalCount, nodes };
}

/**
 * Names a profile may have to count as an exact match: the text as typed, plus
 * the alias-map name when it came from an alias hit (never from a fuzzy guess,
 * which could be a different variant). Fusions also accept "<a>::<b> Fusion".
 */
function exactNameTargets(r: Resolution): { wanted: Set<string>; searchTerms: string[] } {
  const bases = [r.input];
  if (r.resolvedTo && (r.match === "alias_exact" || r.match === "as_typed")) bases.push(r.resolvedTo);

  const wanted = new Set<string>();
  const searchTerms = new Map<string, string>(); // canonical form -> term sent to CIViC
  for (const base of bases) {
    const c = canonName(base);
    wanted.add(c);
    if (c.includes("::") && !c.endsWith(" fusion")) wanted.add(`${c} fusion`);
    if (!searchTerms.has(c)) searchTerms.set(c, base.trim());
  }
  return { wanted, searchTerms: [...searchTerms.values()] };
}

function collectExact(nodes: ProfileRef[], wanted: Set<string>, into: Map<number, ProfileRef>) {
  for (const n of nodes) {
    if (wanted.has(canonName(n.name)) && !into.has(n.id)) into.set(n.id, { id: n.id, name: n.name.trim() });
  }
}

async function findExactProfiles(r: Resolution): Promise<ProfileRef[]> {
  const { wanted, searchTerms } = exactNameTargets(r);
  const found = new Map<number, ProfileRef>();
  const results = await Promise.all(searchTerms.map((t) => searchProfiles(t)));
  for (const { nodes } of results) collectExact(nodes, wanted, found);
  return [...found.values()];
}

/** -----------------------------------------------------------------
 *  Shared evidence / assertion listing
 *  ---------------------------------------------------------------- */
const STATUS_FILTERS = ["ACCEPTED", "SUBMITTED", "NON_REJECTED"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const RESULT_STATUSES = ["ITEMS_FOUND", "PROFILE_FOUND_NO_MATCHING_ITEMS", "NO_SUCH_PROFILE", "NO_MATCHING_ITEMS"] as const;
type ResultStatus = (typeof RESULT_STATUSES)[number];

type ListInput = {
  molecularProfileName?: string;
  diseaseName?: string;
  therapyName?: string;
  clinicalSignificance?: string;
  exactMatch?: boolean;
  status?: StatusFilter;
  limit?: number;
  after?: string;
};

type FilterReport = Resolution & { applied: boolean; note?: string };
type ProfileReport = Resolution & {
  profileMatch: "exact" | "contains";
  matchedProfiles?: ProfileRef[];
  matchedProfileCount?: number;
  note?: string;
};

function filterReport(r: Resolution | undefined, label: string): FilterReport | undefined {
  if (!r) return undefined;
  if (r.match === "not_recognized") {
    return { ...r, applied: false, note: `Not recognized as a CIViC ${label} name, so this filter was NOT applied.` };
  }
  return { ...r, applied: true };
}

type ListKind = {
  connection: "evidenceItems" | "assertions";
  significanceType: "EvidenceSignificance" | "AssertionSignificance";
  fields: string;
  defaultLimit: number;
  idUrlPrefix: string;
  instructions: string;
};

const listQuery = (kind: ListKind) => /* GraphQL */ `
  query ${kind.connection}($molecularProfileId: Int, $molecularProfileName: String, $diseaseName: String, $therapyName: String, $significance: ${kind.significanceType}, $status: EvidenceStatusFilter, $first: Int, $after: String) {
    ${kind.connection}(molecularProfileId: $molecularProfileId, molecularProfileName: $molecularProfileName, diseaseName: $diseaseName, therapyName: $therapyName, significance: $significance, status: $status, first: $first, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${kind.fields} }
    }
  }`;

function listResult(
  kind: ListKind,
  query: unknown,
  resultStatus: ResultStatus,
  totalCount: number,
  items: Record<string, unknown>[],
  nextCursor: string | null,
) {
  const payload = {
    instructions: kind.instructions,
    query,
    resultStatus,
    totalCount,
    returnedCount: items.length,
    hasNextPage: nextCursor !== null,
    nextCursor,
    "API Results": items,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    _meta: { row_count: items.length },
  };
}

async function listCivicRecords(kind: ListKind, input: ListInput) {
  const limit = input.limit ?? kind.defaultLimit;
  const status: StatusFilter = input.status ?? "NON_REJECTED";
  const mp = input.molecularProfileName?.trim() ? resolveProfileName(input.molecularProfileName) : undefined;
  const disease = input.diseaseName?.trim() ? resolveEntity(input.diseaseName, getDiseaseIndex(), 0.7) : undefined;
  const therapy = input.therapyName?.trim() ? resolveEntity(input.therapyName, getTherapyIndex(), 0.7) : undefined;
  const exact = Boolean(input.exactMatch && mp);

  const profileReport: ProfileReport | undefined = mp && { ...mp, profileMatch: exact ? "exact" : "contains" };
  const query = {
    molecularProfile: profileReport,
    disease: filterReport(disease, "disease"),
    therapy: filterReport(therapy, "therapy"),
    clinicalSignificance: input.clinicalSignificance ?? null,
    status,
    limit,
    after: input.after ?? null,
  };

  try {
    let profileId: number | undefined;
    if (exact && mp && profileReport) {
      const matched = await findExactProfiles(mp);
      profileReport.matchedProfiles = matched;
      const notes: string[] = [];
      if (mp.match === "fuzzy") {
        notes.push(`The fuzzy match '${mp.resolvedTo}' was not used for exact matching; only the name as typed was matched.`);
      }
      if (matched.length > 1) {
        notes.push(`${matched.length} CIViC profiles have this exact name; results are for profile ${matched[0].id} only.`);
      }
      if (notes.length) profileReport.note = notes.join(" ");
      if (matched.length === 0) return listResult(kind, query, "NO_SUCH_PROFILE", 0, [], null);
      profileId = matched[0].id;
    }

    const variables = compact({
      molecularProfileId: profileId,
      molecularProfileName: exact ? undefined : mp?.resolvedTo ?? undefined,
      diseaseName: disease?.resolvedTo ?? undefined,
      therapyName: therapy?.resolvedTo ?? undefined,
      significance: parseClinicalSignificance(input.clinicalSignificance),
      status,
      first: limit,
      after: input.after,
    });

    type Connection = {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<Record<string, unknown> & { id: number }>;
    };
    const data = await civicQuery<Record<string, Connection>>(listQuery(kind), variables);
    const conn = data[kind.connection];

    let resultStatus: ResultStatus = "ITEMS_FOUND";
    if (conn.totalCount === 0) {
      if (!mp || !profileReport) {
        resultStatus = "NO_MATCHING_ITEMS";
      } else if (exact) {
        resultStatus = "PROFILE_FOUND_NO_MATCHING_ITEMS";
      } else {
        // Contains mode: is the profile missing from CIViC, or just filtered out?
        const profiles = await searchProfiles(mp.resolvedTo ?? mp.input, 1);
        if (profiles.totalCount === 0) {
          resultStatus = "NO_SUCH_PROFILE";
        } else {
          resultStatus = "PROFILE_FOUND_NO_MATCHING_ITEMS";
          profileReport.matchedProfileCount = profiles.totalCount;
          profileReport.matchedProfiles = profiles.nodes.slice(0, 10).map((p) => ({ id: p.id, name: p.name.trim() }));
        }
      }
    }

    const items = conn.nodes.map((node) => ({ ...node, url: `${kind.idUrlPrefix}${node.id}` }));
    const nextCursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    return listResult(kind, query, resultStatus, conn.totalCount, items, nextCursor);
  } catch (err) {
    return toolError(err, query);
  }
}

/** -----------------------------------------------------------------
 *  Instructions returned with each response
 *  ---------------------------------------------------------------- */
const DISCLAIMER =
  "Medical Disclaimer: Direct use of the CIViC application and website is intended for purely research and educational purposes. It should not be used for emergencies or taken as medical or professional advice.\n";

const LIST_INSTRUCTIONS =
  "query: how each input was interpreted. match='alias_exact' means the name was found in CIViC's names and aliases; 'fuzzy' means it was mapped to the closest known name (resolvedTo, with a similarity score), so mention this if it differs from what the user asked; 'as_typed' means it was sent to CIViC unchanged. A filter with applied=false was not recognized and was NOT applied; tell the user.\n" +
  "molecularProfile.profileMatch: 'contains' returns every profile whose name contains the query, including compound profiles such as 'X AND Y', 'X OR Y' and 'NOT X', so check each item's molecularProfile.name before attributing it to a single variant. 'exact' returns only the profile with exactly that name (matchedProfiles).\n" +
  "resultStatus: ITEMS_FOUND; PROFILE_FOUND_NO_MATCHING_ITEMS = the molecular profile exists in CIViC but no items match the other filters; NO_SUCH_PROFILE = CIViC has no molecular profile with this name (it has not been curated in CIViC); NO_MATCHING_ITEMS = no molecular profile was given and nothing matched.\n" +
  "Paging: totalCount is the number of matching records in CIViC and returnedCount the number in this response. If hasNextPage is true, more exist: call again with the same arguments plus after=nextCursor. Never describe a partial page as the complete set.\n" +
  "status: ACCEPTED = reviewed and accepted by CIViC editors; SUBMITTED = not yet reviewed. Say which items are SUBMITTED when you use them.\n";

const EVIDENCE_INSTRUCTIONS =
  DISCLAIMER +
  LIST_INSTRUCTIONS +
  "Items are sorted by evidence level, then rating.\n" +
  "id / name: CIViC evidence item ID (name is the EID, e.g. EID1409). molecularProfile.id is the CIViC molecular profile ID.\n" +
  "evidenceType: Category describing the type of clinical or biological evidence (e.g., predictive, diagnostic).\n" +
  "evidenceDirection: Indicates whether the evidence supports or refutes the association.\n" +
  "significance: The clinical relevance of the evidence.\n" +
  "description: Detailed summary of the evidence from CIViC curators.\n" +
  "evidenceLevel: Describes the robustness of the study type. A - Validated association, B - Clinical evidence, C - Case study, D - Preclinical evidence, and E - Inferential association\n" +
  "evidenceRating: Quality score assigned to the evidence by curators (scored 1-5).\n" +
  "url: Direct link to the CIViC record for this evidence item.\n" +
  "When returning information to users you MUST cite URLs used for specific information. Always cite both the EIDs and PubMed IDs as links";

const ASSERTION_INSTRUCTIONS =
  DISCLAIMER +
  LIST_INSTRUCTIONS +
  "id / name: CIViC assertion ID (name is the AID, e.g. AID7). molecularProfile.id is the CIViC molecular profile ID.\n" +
  "assertionType: Category describing the type of clinical or biological evidence (e.g., predictive, diagnostic).\n" +
  "assertionDirection: Indicates whether the evidence supports or refutes the association.\n" +
  "significance: The clinical relevance of the evidence.\n" +
  "summary: Detailed summary of the evidence from CIViC curators.\n" +
  "url: Direct link to the CIViC record for this evidence item.\n" +
  "When returning information to users you MUST cite URLs used for specific information. Always cite both the AIDs and PubMed IDs as links";

const BATCH_INSTRUCTIONS =
  DISCLAIMER +
  "status: FOUND = CIViC has a molecular profile with exactly this name (case-insensitive; compound profiles such as 'X AND Y' that merely contain it are not counted); NOT_FOUND = CIViC has no molecular profile with this name (it has not been curated in CIViC).\n" +
  "match / resolvedTo: how the name was interpreted ('alias_exact' = a CIViC name or alias, 'fuzzy' = closest known name, which is not used for exact matching, 'as_typed' = unchanged).\n" +
  "evidenceCounts: number of CIViC evidence items for the profile by review status (accepted = reviewed by CIViC editors, submitted = not yet reviewed). assertionCount: number of CIViC assertions.\n" +
  "These are counts only. To read the evidence, call get_variant_evidence with molecularProfileName set to the profile name and exactMatch=true.\n" +
  "url: link to the molecular profile in CIViC; cite it when reporting these results.";

/** -----------------------------------------------------------------
 *  Input and output schemas
 *  ---------------------------------------------------------------- */
const molecularProfileNameInput = z
  .string()
  .optional()
  .describe("Gene or gene variant, e.g. 'BRAF V600E', 'EGFR', 'BCR::ABL1 Fusion'.");
const diseaseNameInput = z.string().optional().describe("Disease name, e.g. 'Melanoma', 'Lung Non-small Cell Carcinoma'.");
const therapyNameInput = z.string().optional().describe("Therapy (drug) name, e.g. 'Vemurafenib'.");
const exactMatchInput = z
  .boolean()
  .optional()
  .describe(
    "If true, only return records for the molecular profile whose name exactly matches molecularProfileName (case-insensitive). " +
      "Default false: every profile whose name contains the text, including compound profiles such as 'EGFR L858R AND EGFR T790M' or 'NOT KIT D816V'.",
  );
const statusInput = z
  .enum(STATUS_FILTERS)
  .optional()
  .describe("Review status. ACCEPTED = reviewed by CIViC editors; SUBMITTED = not yet reviewed; NON_REJECTED (default) = both.");
const limitInput = (defaultLimit: number) =>
  z.number().int().min(1).max(100).optional().describe(`Maximum number of records to return (1-100, default ${defaultLimit}).`);
const afterInput = z
  .string()
  .optional()
  .describe("Paging cursor: pass nextCursor from a previous response, with otherwise identical arguments, to get the next page.");

const resolutionShape = {
  input: z.string(),
  resolvedTo: z.string().nullable(),
  match: z.enum(["alias_exact", "fuzzy", "as_typed", "not_recognized"]),
  score: z.number().optional(),
};
const profileRefSchema = z.object({ id: z.number().int(), name: z.string() });
const filterReportSchema = z.object({ ...resolutionShape, applied: z.boolean(), note: z.string().optional() });
const listQuerySchema = z.object({
  molecularProfile: z
    .object({
      ...resolutionShape,
      profileMatch: z.enum(["exact", "contains"]),
      matchedProfiles: z.array(profileRefSchema).optional(),
      matchedProfileCount: z.number().int().optional(),
      note: z.string().optional(),
    })
    .optional(),
  disease: filterReportSchema.optional(),
  therapy: filterReportSchema.optional(),
  clinicalSignificance: z.string().nullable(),
  status: z.enum(STATUS_FILTERS),
  limit: z.number().int(),
  after: z.string().nullable(),
});

const namedSchema = z.object({ name: z.string() }).passthrough();
const molecularProfileSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    variants: z.array(z.object({ name: z.string(), feature: namedSchema.nullable() }).passthrough()),
  })
  .passthrough();
const recordBaseShape = {
  id: z.number().int(),
  name: z.string(),
  url: z.string(),
  status: z.string(),
  significance: z.string(),
  therapyInteractionType: z.string().nullable(),
  molecularProfile: molecularProfileSchema,
  disease: z.object({ displayName: z.string() }).passthrough().nullable(),
  therapies: z.array(namedSchema),
  description: z.string(),
};
const evidenceItemSchema = z
  .object({
    ...recordBaseShape,
    evidenceType: z.string(),
    evidenceDirection: z.string(),
    variantOrigin: z.string(),
    evidenceLevel: z.string(),
    evidenceRating: z.number().int().nullable(),
    source: z.object({ sourceUrl: z.string().nullable() }).passthrough(),
  })
  .passthrough();
const assertionSchema = z
  .object({
    ...recordBaseShape,
    assertionType: z.string(),
    assertionDirection: z.string(),
    summary: z.string(),
  })
  .passthrough();

const listOutputShape = (item: z.ZodTypeAny) => ({
  instructions: z.string(),
  query: listQuerySchema,
  resultStatus: z.enum(RESULT_STATUSES),
  totalCount: z.number().int(),
  returnedCount: z.number().int(),
  hasNextPage: z.boolean(),
  nextCursor: z.string().nullable(),
  "API Results": z.array(item),
});

const batchOutputShape = {
  instructions: z.string(),
  checked: z.number().int(),
  found: z.number().int(),
  "API Results": z.array(
    z.object({
      ...resolutionShape,
      status: z.enum(["FOUND", "NOT_FOUND"]),
      profiles: z.array(
        z.object({
          id: z.number().int(),
          name: z.string(),
          url: z.string(),
          evidenceCounts: z.object({ accepted: z.number().int(), submitted: z.number().int(), rejected: z.number().int() }),
          assertionCount: z.number().int(),
        }),
      ),
    }),
  ),
};

const RECORD_PROFILE_FIELDS = "molecularProfile { id name variants { name feature { name } } }";

const EVIDENCE_KIND: ListKind = {
  connection: "evidenceItems",
  significanceType: "EvidenceSignificance",
  fields: `id name status evidenceType evidenceDirection significance therapyInteractionType ${RECORD_PROFILE_FIELDS}
    disease { displayName } therapies { name } variantOrigin description evidenceLevel evidenceRating source { sourceUrl }`,
  defaultLimit: 50,
  idUrlPrefix: "https://identifiers.org/civic.eid:",
  instructions: EVIDENCE_INSTRUCTIONS,
};

const ASSERTION_KIND: ListKind = {
  connection: "assertions",
  significanceType: "AssertionSignificance",
  fields: `id name status assertionType assertionDirection significance therapyInteractionType ${RECORD_PROFILE_FIELDS}
    disease { displayName } therapies { name } summary description`,
  defaultLimit: 100,
  idUrlPrefix: "https://identifiers.org/civic.aid:",
  instructions: ASSERTION_INSTRUCTIONS,
};

/** -----------------------------------------------------------------
 *  Tool definitions
 *  ---------------------------------------------------------------- */
export const tools = {
  /** ───────────────────────── get_variant_evidence ─────────────────────── */
  getVariantEvidence: {
    name: "get_variant_evidence",
    title: "Get CIViC Variant Evidence",
    description:
      "Retrieves curated CIViC Evidence Items for cancer-associated variants. Results can be optionally filtered by molecular profile (gene or gene variant)," +
      " disease, therapy, clinical significance (e.g., resistance, sensitivity, oncogenicity) and review status." +
      " Set exactMatch=true to get only the profile with exactly that name (no compound profiles)." +
      " Results are paged: check totalCount and hasNextPage, and pass nextCursor as `after` to get more.",
    inputSchema: {
      molecularProfileName: molecularProfileNameInput,
      diseaseName:          diseaseNameInput,
      therapyName:          therapyNameInput,
      clinicalSignificance: z.enum([
          "Predictive: SensitivityResponse",
          "Predictive: Resistance",
          "Predictive: Adverse_Response",
          "Diagnostic: Positive",
          "Prognostic: Better_Outcome",
          "Prognostic: Poor_Outcome",
          "Predisposing: Predisposition",
          "Oncogenic: Oncogenicity",
          "Functional: Gain_of_Function",
          "Functional: Loss_of_Function",
          "Functional: Dominant_Negative"
        ]).optional(),
      exactMatch: exactMatchInput,
      status:     statusInput,
      limit:      limitInput(EVIDENCE_KIND.defaultLimit),
      after:      afterInput,
    },
    outputSchema: listOutputShape(evidenceItemSchema),
    handler: (input: ListInput) => listCivicRecords(EVIDENCE_KIND, input),
  },

  /** ───────────────────────── get_variant_assertions ───────────────────── */
  getVariantAssertions: {
    name: "get_variant_assertions",
    title: "Get CIViC Variant Assertions",
    description:
      "Retrieves curated CIViC Assertions for cancer-associated variants. Results can be optionally filtered by molecular profile (gene or gene variant)," +
      " disease, therapy, clinical significance (e.g., resistance, sensitivity, oncogenicity) and review status." +
      " Set exactMatch=true to get only the profile with exactly that name (no compound profiles)." +
      " Results are paged: check totalCount and hasNextPage, and pass nextCursor as `after` to get more.",
    inputSchema: {
      molecularProfileName: molecularProfileNameInput,
      diseaseName:          diseaseNameInput,
      therapyName:          therapyNameInput,
      clinicalSignificance: z.enum([
          "Predictive: SensitivityResponse",
          "Predictive: Resistance",
          "Predictive: Reduced_Sensitivity",
          "Predictive: Adverse_Response",
          "Diagnostic: Positive",
          "Diagnostic: Negative",
          "Prognostic: Better_Outcome",
          "Prognostic: Poor_Outcome",
          "Predisposing: Pathogenic",
          "Predisposing: Likely_Pathogenic",
          "Oncogenic: Oncogenic",
          "Oncogenic: Likely_Oncogenic",
          "Predisposing/Oncogenic: Uncertain_Significance",
          "Predisposing/Oncogenic: Likely_Benign",
          "Predisposing/Oncogenic: Benign"
        ]).optional(),
      exactMatch: exactMatchInput,
      status:     statusInput,
      limit:      limitInput(ASSERTION_KIND.defaultLimit),
      after:      afterInput,
    },
    outputSchema: listOutputShape(assertionSchema),
    handler: (input: ListInput) => listCivicRecords(ASSERTION_KIND, input),
  },

  /** ───────────────────────── check_molecular_profiles ─────────────────── */
  checkMolecularProfiles: {
    name: "check_molecular_profiles",
    title: "Check Molecular Profiles in CIViC",
    description:
      "Checks up to 50 molecular profile names (gene + variant, e.g. 'KRAS G12C') against CIViC in one call. For each name, returns the CIViC" +
      " molecular profile with exactly that name (if any), its evidence item counts by review status and its assertion count." +
      " Use it to see which variants CIViC has curated, then fetch evidence with get_variant_evidence (exactMatch=true).",
    inputSchema: {
      molecularProfileNames: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Molecular profile names to check, e.g. ['KRAS G12C', 'EGFR T790M', 'STK11 D53Tfs*11']."),
    },
    outputSchema: batchOutputShape,
    async handler({ molecularProfileNames }: { molecularProfileNames: string[] }) {
      const names = molecularProfileNames.map((n) => n.trim()).filter(Boolean);
      const resolutions = names.map(resolveProfileName);
      const targets = resolutions.map(exactNameTargets);

      try {
        // 1) One substring search per distinct term, batched with GraphQL aliases.
        const terms = [...new Set(targets.flatMap((t) => t.searchTerms))];
        const nodesByTerm = new Map<string, ProfileRef[]>();
        for (let i = 0; i < terms.length; i += 20) {
          const chunk = terms.slice(i, i + 20);
          const query = `query (${chunk.map((_, j) => `$t${j}: String`).join(", ")}) { ${chunk
            .map((_, j) => `t${j}: molecularProfiles(name: $t${j}, first: 300) { nodes { id name } }`)
            .join(" ")} }`;
          const data = await civicQuery<Record<string, { nodes: ProfileRef[] }>>(
            query,
            Object.fromEntries(chunk.map((t, j) => [`t${j}`, t])),
          );
          chunk.forEach((t, j) => nodesByTerm.set(t, data[`t${j}`].nodes));
        }

        // 2) Exact-name matches for each input.
        const matched = targets.map(({ wanted, searchTerms }) => {
          const found = new Map<number, ProfileRef>();
          for (const t of searchTerms) collectExact(nodesByTerm.get(t) ?? [], wanted, found);
          return [...found.values()];
        });

        // 3) Evidence and assertion counts for every matched profile.
        type Detail = {
          evidenceCountsByStatus: { acceptedCount: number; submittedCount: number; rejectedCount: number };
          assertions: { totalCount: number };
        };
        const ids = [...new Set(matched.flat().map((p) => p.id))];
        const details = new Map<number, Detail>();
        for (let i = 0; i < ids.length; i += 25) {
          const chunk = ids.slice(i, i + 25);
          const query = `query { ${chunk
            .map((id) => `p${id}: molecularProfile(id: ${id}) { evidenceCountsByStatus { acceptedCount submittedCount rejectedCount } assertions { totalCount } }`)
            .join(" ")} }`;
          const data = await civicQuery<Record<string, Detail | null>>(query);
          for (const id of chunk) {
            const d = data[`p${id}`];
            if (d) details.set(id, d);
          }
        }

        const results = names.map((_, i) => ({
          ...resolutions[i],
          status: matched[i].length > 0 ? ("FOUND" as const) : ("NOT_FOUND" as const),
          profiles: matched[i].map((p) => {
            const d = details.get(p.id);
            return {
              id: p.id,
              name: p.name,
              url: `https://civicdb.org/molecular-profiles/${p.id}/summary`,
              evidenceCounts: {
                accepted: d?.evidenceCountsByStatus.acceptedCount ?? 0,
                submitted: d?.evidenceCountsByStatus.submittedCount ?? 0,
                rejected: d?.evidenceCountsByStatus.rejectedCount ?? 0,
              },
              assertionCount: d?.assertions.totalCount ?? 0,
            };
          }),
        }));

        const payload = {
          instructions: BATCH_INSTRUCTIONS,
          checked: results.length,
          found: results.filter((r) => r.status === "FOUND").length,
          "API Results": results,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          _meta: { row_count: results.length },
        };
      } catch (err) {
        return toolError(err, { molecularProfileNames: names });
      }
    },
  },
} as const;



// 2) Register tools using registerTool() inside init()
class CivicMCP extends McpAgent {
  server = new McpServer(
    { name: API_CONFIG.name, version: API_CONFIG.version, description: API_CONFIG.description },
    { instructions: `Use the tools to answer precision oncology questions for the Clinical Interpretations of Variants in Cancer (CIViC) knowledgebase.` }
  );

  async init() {
    for (const tool of Object.values(tools)) {
      this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: {
            readOnlyHint: true,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        } as any,
        tool.handler as any
      );
    }
  }
}

// -------------------------------------------------------------
// CLOUDFLARE WORKER RUNTIME (SSE only)
// -------------------------------------------------------------
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}


// export default {
//   async fetch(
//     request: Request,
//     env: Env,               // keep the typed Env like before
//     ctx: ExecutionContext
//   ): Promise<Response> {
//     const url = new URL(request.url);

//     console.log(Object.keys(env));

//     /* ────────────────────────────────────────────────
//        SSE transport (Claude Desktop, Cursor, etc.)
//     ─────────────────────────────────────────────────*/
//     if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
//       // MCP 2025-06-18: client may send its protocol version
//       const protocolVersion = request.headers.get("MCP-Protocol-Version");

//       // @ts-ignore – serveSSE helper is mixed-in by CivicMCP
//       const response = await CivicMCP.serveSSE("/sse").fetch(request, env, ctx);

//       // Mirror the header back so the client sees what the server supports
//       if (protocolVersion && response instanceof Response) {
//         const headers = new Headers(response.headers);
//         headers.set("MCP-Protocol-Version", protocolVersion);
//         return new Response(response.body, {
//           status: response.status,
//           statusText: response.statusText,
//           headers
//         });
//       }

//       return response; // unchanged fallback
//     }

//     return new Response(
//       `${API_CONFIG.name} – MCP Server ${API_CONFIG.version}. Use /sse for MCP transport.`,
//       { status: 200, headers: { "Content-Type": "text/plain" } }
//     );
//   }
// };

// Base64 of favicon.ico (small multi-size ico)
const FAVICON_ICO_B64 = "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";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    console.log(Object.keys(env));

    if (url.pathname === "/") {
        const accept = request.headers.get("Accept") ?? "";
        if (accept.includes("text/html")) {
          return new Response(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <link rel="icon" href="/favicon.ico" type="image/x-icon" />
          <link rel="icon" href="/favicon-256.png" type="image/png" sizes="256x256" />
          <link rel="apple-touch-icon" href="/favicon-256.png" />
          <title>CIViC MCP</title>
        </head>
        <body>CIViC MCP</body>
      </html>`, { headers: { "Content-Type": "text/html; charset=utf-8" }});
        }

        return new Response(
          `${API_CONFIG.name} – MCP Server ${API_CONFIG.version}. Use /mcp (Streamable HTTP) or /sse (legacy).`,
          { status: 200, headers: { "Content-Type": "text/plain" } }
        );
      }

    //   if (url.pathname === "/favicon-256.png") {
    //   // Serve the largest PNG embedded in the ICO
    //   // The 256x256 PNG is the last image in the ICO bundle
    //   return new Response(b64ToBytes(FAVICON_256_PNG_B64), {
    //     headers: {
    //       "Content-Type": "image/png",
    //       "Cache-Control": "public, max-age=86400",
    //     },
    //   });
    // }

    if (url.pathname === "/favicon.ico") {
      return new Response(b64ToBytes(FAVICON_ICO_B64), {
        headers: {
          "Content-Type": "image/x-icon",
          // while testing, disable caching to avoid “still seeing the old one”
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/privacy") {
        const html = `<!doctype html>
        <html><head><meta charset="utf-8"><title>Privacy Policy</title></head>
        <body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5">
          <h1>Privacy Policy</h1>
          <p><strong>What this service does:</strong> This MCP server receives query terms you provide (e.g., molecular profile, disease, therapy) and forwards them to the CIViC GraphQL API to retrieve curated results.</p>
          <p><strong>Data we process:</strong> The text inputs you submit to the tools and standard request metadata.</p>
          <p><strong>How we use data:</strong> Only to fulfill your request and return CIViC results.</p>
          <p><strong>Data sharing:</strong> Requests are sent to (1) Cloudflare (hosting/infrastructure) and (2) the CIViC API at civicdb.org.</p>
          <p><strong>Data retention:</strong> We do not intentionally store your tool inputs in an application database. Cloudflare Workers Observability is enabled and may retain operational logs/telemetry for debugging and service reliability.</p>
          <p><strong>Security:</strong> Data is transmitted over HTTPS/TLS.</p>
          <p><em>Last updated: 2026-02-27</em></p>
        </body></html>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

    /* ────────────────────────────────────────────────
       NEW: Streamable HTTP transport (/mcp)
    ─────────────────────────────────────────────────*/
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const protocolVersion = request.headers.get("MCP-Protocol-Version");

      // @ts-ignore – serve helper is mixed-in by CivicMCP (Streamable HTTP)
      const response = await CivicMCP.serve("/mcp").fetch(request, env, ctx);

      if (protocolVersion && response instanceof Response) {
        const headers = new Headers(response.headers);
        headers.set("MCP-Protocol-Version", protocolVersion);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
      return response;
    }

    /* ────────────────────────────────────────────────
       Legacy SSE transport (kept for now)
    ─────────────────────────────────────────────────*/
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      const protocolVersion = request.headers.get("MCP-Protocol-Version");

      // @ts-ignore – serveSSE helper is mixed-in by CivicMCP (SSE)
      const response = await CivicMCP.serveSSE("/sse").fetch(request, env, ctx);

      if (protocolVersion && response instanceof Response) {
        const headers = new Headers(response.headers);
        headers.set("MCP-Protocol-Version", protocolVersion);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
      return response;
    }

   /* ────────────────────────────────────────────────
       Everything else → 404
       (Must not be 200, or clients treat fallback OAuth
       endpoints like /register, /authorize, /token as real.)
       The info banner is still served at "/" above.
    ─────────────────────────────────────────────────*/
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
};

// Export the class for tests if you like
export { CivicMCP };