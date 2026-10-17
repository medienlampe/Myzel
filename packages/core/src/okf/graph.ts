import type { Bundle } from "./bundle.js";

export interface GraphNode {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  /** Total degree (inbound + outbound, deduped per direction). */
  links: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphScan extends GraphData {
  /** Outbound links whose target concept does not exist. */
  brokenLinks: { path: string; target: string }[];
  /** Inbound-degree per concept path (index/log catalogs don't count). */
  inbound: Map<string, number>;
}

/**
 * A markdown link to a concept: `](/path/to/concept.md)` or, per spec §6.1, a
 * path relative to the linking file (`](billing.md)`, `](../apis/x.md)`) — what
 * editors, Obsidian and GitHub write. URLs with a scheme or `//host` are not
 * concept links. Brackets and parentheses are excluded from the path so a match
 * attempt stops at the next link — with them allowed, a body of repeated "](/"
 * made every attempt scan to the end of the text (quadratic; seconds per
 * request on a large concept).
 */
export const CONCEPT_LINK_RE = /\]\((?![a-z][a-z0-9+.-]*:|\/\/)([^()[\]#?\s]+\.md)\)/gi;

/**
 * The bundle paths a concept's body links to, resolved against the concept's
 * own directory. Links that climb above the bundle root point outside it and
 * are not concept links.
 */
export function conceptLinkTargets(body: string, sourcePath: string): string[] {
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  const targets: string[] = [];
  for (const match of body.matchAll(CONCEPT_LINK_RE)) {
    const href = match[1];
    const parts: string[] = [];
    let outside = false;
    for (const seg of (href.startsWith("/") ? href : `${dir}/${href}`).split("/")) {
      if (seg === "..") {
        if (parts.length === 0) outside = true;
        parts.pop();
      } else if (seg !== "" && seg !== ".") parts.push(decodeSegment(seg));
    }
    if (!outside) targets.push(`/${parts.join("/")}`);
  }
  return targets;
}

/** Index links are percent-encoded (spaces, "#", parentheses in file names). */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * One pass over the bundle building the inter-concept link graph.
 * Reserved files (index.md/log.md) are not link sources — their generated
 * catalogs link everything, which would drown the real relationships.
 * Shared by lint (health) and the graph API (visualization).
 */
export async function scanGraph(bundle: Bundle): Promise<GraphScan> {
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);

  const nodes = new Map<string, GraphNode>();
  // Bodies are only needed for the link pass below, so they stay in their own
  // map rather than riding along on the nodes we are about to return.
  const bodies = new Map<string, string>();
  for (const p of paths) {
    let title: string | undefined;
    let type: string | undefined;
    let description: string | undefined;
    let body = "";
    try {
      const concept = await bundle.readConcept(p);
      body = concept.body;
      const fm = concept.frontmatter;
      if (typeof fm.title === "string") title = fm.title;
      if (typeof fm.type === "string") type = fm.type;
      if (typeof fm.description === "string") description = fm.description;
    } catch {
      // Permissive: unreadable concept still appears as a node.
    }
    nodes.set(p, { path: p, title, type, description, links: 0 });
    bodies.set(p, body);
  }

  const edges: GraphEdge[] = [];
  const brokenLinks: { path: string; target: string }[] = [];
  const inbound = new Map<string, number>();
  for (const p of paths) inbound.set(p, 0);

  for (const source of nodes.keys()) {
    const body = bodies.get(source) ?? "";
    const targeted = new Set<string>();
    for (const target of conceptLinkTargets(body, source)) {
      if (target === source || targeted.has(target)) continue;
      targeted.add(target);
      if (known.has(target)) {
        edges.push({ source, target });
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      } else {
        brokenLinks.push({ path: source, target });
      }
    }
  }

  for (const edge of edges) {
    nodes.get(edge.source)!.links++;
    nodes.get(edge.target)!.links++;
  }

  return { nodes: [...nodes.values()], edges, brokenLinks, inbound };
}

/** Public graph shape for the API/UI (no scan internals). */
export async function buildGraph(bundle: Bundle): Promise<GraphData> {
  const { nodes, edges } = await scanGraph(bundle);
  return { nodes, edges };
}
