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

//export const dGeneMap:    Record<string, string[]>  = rawGeneMap     as Record<string, string[]>;

// import diseaseData from "./data/inverted_resolver_disease_500.json";
// import therapyData from "./data/inverted_resolver_therapy_500.json";
// import molecularData from "./data/inverted_resolver_molecular_500.json";

import { findBestMatch } from 'string-similarity'

type CompositeKind = "molecularProfile" | "therapy";

const MP_SPLIT_RE = /\b(?:AND|OR)\b/i;

// NOTE: therapy splitting is intentionally broader
const THERAPY_SPLIT_RE = /\b(?:AND|OR)\b|[,;|/]|\bplus\b|[+&]/i;

function splitComposite(name: string, kind: CompositeKind): string[] {
  const raw =
    kind === "molecularProfile"
      ? name.split(MP_SPLIT_RE)
      : name.split(THERAPY_SPLIT_RE);

  return raw.map(s => s.trim()).filter(Boolean);
}

function optionalFilter(s?: string | null): string | undefined {
  if (s == null) return undefined;
  const t = s.trim();
  if (!t) return undefined;

  // Sentinels that should mean "no filter"
  if (/^(none|null|na|n\/a|not applicable)$/i.test(t)) return undefined;

  return t;
}

function stripMutationQualifier(name: string): string {
  return name.replace(/\s+mutat\w*/gi, "").trim();
}

/**
 * If composite, pick ONE part to send to the API.
 * Strategy: choose the part with the highest similarity score to the index candidates.
 * - exact match -> immediate winner
 * - else fuzzy score; keep best; ties resolved by earliest in the string
 * - if nothing clears threshold, fall back to the first part (still better than sending the whole composite)
 */
export function pickOneForApi(
  name: string | undefined | null,
  index: AliasIndex,
  threshold: number,
  kind: CompositeKind
): { picked: string | undefined; parts: string[]; pickedReason: string } {
  if (!name) return { picked: undefined, parts: [], pickedReason: "missing" };

  const parts = splitComposite(name, kind);
  if (parts.length <= 1) {
    // single input: normal behavior
    const single = normalizeEntityFast(name, index, threshold, { fallbackToOriginal: true });
    return { picked: single, parts, pickedReason: "single" };
  }

  let bestPicked = parts[0];
  let bestScore = -1;
  let bestReason = "fallback_first";

  for (const part of parts) {
    const qNorm = normalizeStr(part);

    // exact alias/primary match
    const exact = index.aliasToPrimary[qNorm];
    if (exact) {
      return { picked: exact, parts, pickedReason: "exact" };
    }

    // fuzzy score
    const { bestMatch } = findBestMatch(qNorm, index.candidates);
    const score = bestMatch.rating;

    if (score > bestScore) {
      bestScore = score;
      bestPicked = score >= threshold ? index.aliasToPrimary[bestMatch.target] : part;
      bestReason = score >= threshold ? `fuzzy_${score.toFixed(3)}` : `below_threshold_${score.toFixed(3)}`;
    }
  }

  return { picked: bestPicked, parts, pickedReason: bestReason };
}

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

const BOOLEAN_OP_RE = /\b(?:AND|OR)\b/i;

// Therapy strings are often multi-drug regimens written as:
// "A, B"  |  "A + B"  |  "A/B"  |  "A and B"  |  "A & B"  |  "A; B"
const THERAPY_COMPOSITE_RE =
  /\b(?:AND|OR)\b|[,;/|]|\bplus\b|[+&]/i;

function looksComposite(name: string, kind: CompositeKind): boolean {
  if (kind === "molecularProfile") {
    // Avoid false-positives for MPs (e.g., HGVS intronic "+1") — only bypass on AND/OR
    return BOOLEAN_OP_RE.test(name);
  }
  // Therapy: bypass on AND/OR OR any common multi-drug separators
  return THERAPY_COMPOSITE_RE.test(name);
}

export function normalizeEntityFast(
  name: string | undefined | null,
  index: AliasIndex,
  threshold = 0.7,
  opts?: {
    // Old behavior (kept for compatibility)
    bypassBooleanOps?: boolean;

    // New: skip normalization when input looks like multiple entities
    bypassComposite?: boolean;
    compositeKind?: CompositeKind;

    fallbackToOriginal?: boolean; // return original if no good match
  }
): string | undefined {
  if (!name) return undefined;

  // Back-compat: old boolean-only bypass
  if (opts?.bypassBooleanOps && BOOLEAN_OP_RE.test(name)) {
    return name;
  }

  // New composite bypass
  if (opts?.bypassComposite) {
    const kind = opts.compositeKind ?? "molecularProfile";
    if (looksComposite(name, kind)) {
      return name; // ✅ don't normalize composites (AND/OR, lists, combos)
    }
  }

  const qNorm = normalizeStr(name);

  // ✅ exact match first
  const exact = index.aliasToPrimary[qNorm];
  if (exact) return exact;

  // fuzzy match second
  const { bestMatch } = findBestMatch(qNorm, index.candidates);

  if (bestMatch.rating >= threshold) {
    return index.aliasToPrimary[bestMatch.target];
  }

  return opts?.fallbackToOriginal ? name : undefined;
}

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
  version:     "0.1.0",
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
    "User-Agent": "MCPCivicServer/0.1.0",
    "Content-Type": "application/json",
  },
} as const;

/** -----------------------------------------------------------------
 *  Tool definitions
 *  ---------------------------------------------------------------- */
type EvidenceInput   = { molecularProfileName: string; diseaseName?: string; therapyName?: string };

export const tools = {
  /** ───────────────────────── get_variant_evidence ─────────────────────── */
  getVariantEvidence: {
    name: "get_variant_evidence",
    description:
      "Retrieves evidence items for a CIViC molecular profile, " +
      "optionally filtered by disease and/or therapy. Cite URLs used for specific information.",
    inputSchema: {
      molecularProfileName: z.string(),
      diseaseName:          z.string().optional(),
      therapyName:          z.string().optional(),
    },
    annotations: {
          readOnlyHint: true,
          openWorldHint: true,
        },
    async handler({ molecularProfileName, diseaseName, therapyName }: EvidenceInput) {

      // const variables = compact({
      //   molecularProfileName: resolveMolecularProfile(molecularProfileName),
      //   diseaseName:          resolveDisease(diseaseName),
      //   therapyName:          resolveTherapy(therapyName),
      // });

      // const variables = compact({
      //   molecularProfileName: normalizeEntity(molecularProfileName, dMPMap,   0.7),
      //   diseaseName:          normalizeEntity(diseaseName,      dDiseaseMap, 0.7),
      //   therapyName:          normalizeEntity(therapyName,      dTherapyMap, 0.7),
      // });

      const mpClean      = optionalFilter(molecularProfileName); // (mp is required anyway)
      const diseaseClean = optionalFilter(diseaseName);
      const therapyClean = optionalFilter(therapyName);         

      const mpForApi = mpClean && /mutat/i.test(mpClean)
        ? stripMutationQualifier(mpClean)
        : mpClean;

      const mpPick = pickOneForApi(mpForApi, getMPIndex(), 0.7, "molecularProfile");

      const txPick = therapyClean
        ? pickOneForApi(therapyClean, getTherapyIndex(), 0.7, "therapy")
        : { picked: undefined, parts: [], pickedReason: "missing_or_none" as const };

      const variables = compact({
        molecularProfileName: mpPick.picked, // required
        diseaseName:          diseaseClean ? normalizeEntityFast(diseaseClean, getDiseaseIndex(), 0.7) : undefined,
        therapyName:          txPick.picked, // ✅ will be undefined if input was "None"
      });

      const query = /* GraphQL */ `
        query evidenceItems($molecularProfileName: String!, $diseaseName: String, $therapyName: String) {
        evidenceItems( molecularProfileName: $molecularProfileName, diseaseName: $diseaseName, therapyName: $therapyName, first: 20) {
            nodes { 
                status 
                evidenceType
                evidenceDirection 
                significance
                therapyInteractionType
                molecularProfile{
                    name
                    variants{
                        name
                        feature{
                            name
                        }
                    }
                }
                disease{
                    displayName
                }
                therapies{
                    name
                }
                variantOrigin 
                description
                evidenceLevel
                evidenceRating
                source {
                  sourceUrl
                }
                id 
            }
        }
      }`;

        const res = await fetch("https://civicdb.org/api/graphql", {
          method: "POST",
          headers: API_CONFIG.headers,
          body: JSON.stringify({ query, variables }),
        }).then((r) => r.json()) as {
          data?: { evidenceItems?: { nodes: Record<string, unknown>[] } };
          errors?: unknown[];
        };

        const nodes = res.data?.evidenceItems?.nodes ?? [];

      // ✅ Debug print ONLY when no evidence is returned
      const noEvidence = Array.isArray(nodes) && nodes.length === 0;

      // Build debug ONLY when empty
      const debug = noEvidence
        ? {
            passed_to_api: variables,
            picked_for_api: {
              molecularProfileName: { picked: mpPick.picked, parts: mpPick.parts, reason: mpPick.pickedReason },
              therapyName:          { picked: txPick.picked, parts: txPick.parts, reason: txPick.pickedReason },
            },
            normalized: {
              // keep this if you still want a "what would normalization do" view for the originals:
              molecularProfileName: normalizeEntityFast(molecularProfileName, getMPIndex(), 0.7, { fallbackToOriginal: true }),
              diseaseName:          normalizeEntityFast(diseaseName,          getDiseaseIndex(), 0.7),
              therapyName:          normalizeEntityFast(therapyName,          getTherapyIndex(), 0.7, { fallbackToOriginal: true }),
            },
            original: { molecularProfileName, diseaseName, therapyName },
            mutation_qualifier_stripped: mpClean !== mpForApi
              ? { original: mpClean, stripped: mpForApi }
              : undefined,
            graphql_errors: res.errors ?? null,
          }
        : undefined;

        // Default fallback if query failed
        const rawItems = res.data?.evidenceItems?.nodes ?? res;

        // Only transform if it's an array of evidence items
        const evidenceItems = Array.isArray(rawItems)
          ? rawItems.map((item) => {
              const copy = { ...item } as Record<string, unknown>;
              const id = copy["id"];
              if (typeof id === "string" || typeof id === "number") {
                copy["url"] = `https://identifiers.org/civic.eid:${id}`;
              }
              delete copy["id"];
              return copy;
            })
          : rawItems;

        const instructions =
          "evidenceType: Category describing the type of clinical or biological evidence (e.g., predictive, diagnostic).\n" +
          "evidenceDirection: Indicates whether the evidence supports or refutes the association.\n" +
          "significance: The clinical relevance of the evidence.\n" +
          "description: Detailed summary of the evidence from CIViC curators.\n" +
          "evidenceLevel: Describes the robustness of the study type. A - Validated association, B - Clinical evidence, C - Case study, D - Preclinical evidence, and E - Inferential association\n" +
          "evidenceRating: Quality score assigned to the evidence by curators (scored 1-5).\n" +
          "url: Direct link to the CIViC record for this evidence item.\n" +
          "When returning information to users you MUST cite URLs used for specific information. Always cite both the EIDs and PubMed IDs as links";

        const payload = {
          instructions,
          "API Results": evidenceItems,
          _debug: debug, // ✅ returned to the caller when empty
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          _meta: {
            row_count: Array.isArray(evidenceItems) ? evidenceItems.length : undefined,
          },
        };
    },
  },

  /** ───────────────────────── get_variant_assertions ───────────────────── */
  getVariantAssertions: {
    name: "get_variant_assertions",
    description:
      "Retrieves CIViC assertions for a molecular profile; optionally filter by disease. Cite URLs used for specific information.",
    inputSchema: {
      molecularProfileName: z.string(),
      diseaseName:          z.string().optional(),
      therapyName:          z.string().optional(),
    },
    annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    async handler({ molecularProfileName, diseaseName, therapyName }: EvidenceInput) {

      // const variables = compact({
      //   molecularProfileName: normalizeEntity(molecularProfileName, dMPMap,   0.7),
      //   diseaseName:          normalizeEntity(diseaseName,      dDiseaseMap, 0.7),
      //   therapyName:          normalizeEntity(therapyName,      dTherapyMap, 0.7),
      // });

      const mpClean      = optionalFilter(molecularProfileName); // (mp is required anyway)
      const diseaseClean = optionalFilter(diseaseName);
      const therapyClean = optionalFilter(therapyName);         

      const mpForApi = mpClean && /mutat/i.test(mpClean)
        ? stripMutationQualifier(mpClean)
        : mpClean;
 
      // Only pick a therapy if we still have a real value
      const mpPick = pickOneForApi(mpForApi, getMPIndex(), 0.7, "molecularProfile");
      const txPick = therapyClean
        ? pickOneForApi(therapyClean, getTherapyIndex(), 0.7, "therapy")
        : { picked: undefined, parts: [], pickedReason: "missing_or_none" as const };

      const variables = compact({
        molecularProfileName: mpPick.picked, // required
        diseaseName:          diseaseClean ? normalizeEntityFast(diseaseClean, getDiseaseIndex(), 0.7) : undefined,
        therapyName:          txPick.picked, // ✅ will be undefined if input was "None"
      });

      const query = /* GraphQL */ `
        query assertions($molecularProfileName: String!, $diseaseName: String, $therapyName: String) {
        assertions(molecularProfileName: $molecularProfileName, diseaseName: $diseaseName, therapyName: $therapyName) {
            nodes { 
                status 
                assertionType
                assertionDirection 
                significance
                therapyInteractionType
                molecularProfile{
                name
                variants{
                        name
                        feature{
                            name
                        }
                    }
                }
                disease{
                    displayName
                }
                therapies{
                    name
                } 
                summary
                description
                id 
            }
        }
      }`;

        const res = await fetch("https://civicdb.org/api/graphql", {
          method: "POST",
          headers: API_CONFIG.headers,
          body: JSON.stringify({ query, variables }),
        }).then((r) => r.json()) as {
          data?: { assertions?: { nodes: Record<string, unknown>[] } };
          errors?: unknown[];
        };

        const rawItems = res.data?.assertions?.nodes ?? res;

        // Only transform if it's an array of assertions
        const assertions = Array.isArray(rawItems)
          ? rawItems.map((item) => {
              const copy = { ...item } as Record<string, unknown>;
              const id = copy["id"];
              if (typeof id === "string" || typeof id === "number") {
                copy["url"] = `https://identifiers.org/civic.aid:${id}`;
              }
              delete copy["id"];
              return copy;
            })
          : rawItems;

        const instructions =
          "assertionType: Category describing the type of clinical or biological evidence (e.g., predictive, diagnostic).\n" +
          "assertionDirection: Indicates whether the evidence supports or refutes the association.\n" +
          "significance: The clinical relevance of the evidence.\n" +
          "summary: Detailed summary of the evidence from CIViC curators.\n" +
          "url: Direct link to the CIViC record for this evidence item.\n" +
          "When returning information to users you MUST cite URLs used for specific information. Always cite both the AIDs and PubMed IDs as links";

        const payload = {
          instructions,
          "API Results": assertions,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          _meta: {
            row_count: Array.isArray(assertions) ? assertions.length : undefined,
          },
        };
    },
  },
} as const;



// -------------------------------------------------------------
// MCP SERVER (only the two fixed tools)
// -------------------------------------------------------------
class CivicMCP extends McpAgent {
  server = new McpServer(
    { name: API_CONFIG.name, version: API_CONFIG.version, description: API_CONFIG.description },
    { instructions: `Use the tools to answer precision oncology questions for the Clinical Interpretations of Variants in Cancer (CIViC) knowledgebase.` }
  );

    async init() {
    const { getVariantEvidence, getVariantAssertions } = tools;

    // Evidence
    this.server.registerTool(
      getVariantEvidence.name,
      {
        title: "Get CIViC variant evidence",
        description: getVariantEvidence.description,
        inputSchema: getVariantEvidence.inputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      } as any,
      getVariantEvidence.handler as any
    );

    // Assertions
    this.server.registerTool(
      getVariantAssertions.name,
      {
        title: "Get CIViC variant assertions",
        description: getVariantAssertions.description,
        inputSchema: getVariantAssertions.inputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      } as any,
      getVariantAssertions.handler as any
    );
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    console.log(Object.keys(env));

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

    return new Response(
      `${API_CONFIG.name} – MCP Server ${API_CONFIG.version}. Use /mcp (Streamable HTTP) or /sse (legacy).`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  }
};

// Export the class for tests if you like
export { CivicMCP };