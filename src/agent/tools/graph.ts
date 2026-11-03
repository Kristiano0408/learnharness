import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { chainsForSelection } from "../../core/chains.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import type { GraphNode } from "../../core/contracts/graph.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";

/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const listSessionsInput = Type.Object({});

const listPropositionsInput = Type.Object({
	session: Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id)",
	}),
});

export function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	return {
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the sessions of the learner's persistent knowledge graph — every chat or imported-notes file that ever contributed a proposition, most recent first. The map is organized into birth-session clusters (propositions grouped by the session they were first learned in), and session names are those clusters' labels. " +
				"Each line: the session's name, kind (chat/file), how many propositions were born in it, its dates, and its id — use that id with list_propositions. " +
				"Reading this first shows what he has already covered and when, before you probe anything.",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) =>
					`${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}, ` +
					`born ${s.createdAt ?? "unknown date"}${s.updatedAt ? `, last active ${s.updatedAt}` : ""}) — id: ${s.id}`,
				);
				return `${sessions.length} session(s) in the knowledge graph, most recent first:\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one knowledge-graph session — what was covered there. " +
				"Names only — no statement text, no session contents (owner ruling 2026-09-23: the map's ORGANIZATION is your business, its prose is not).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) {
					return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				}
				const lines = propositions.map((p) => `- ${p.name}`);
				return `${propositions.length} proposition(s) covered in this session:\n${lines.join("\n")}`;
			}),
		},
	};
}

// ─── the practitioner's whole-map reader (session-wave fix, 2026-11-03) ─────

/**
 * THE PRACTITIONER'S `read_graph` (session-wave fix, 2026-11-03): the map
 * readers the practice agent carries are per-session — without picks the AI
 * must already know a session id to reach ANY proposition, so it never sees
 * the workspace's graph whole. This is the ONE-call whole-map read, owned by
 * the same settings gate as every other map tool (the composition root passes
 * `graph` only when graphToolsEnabled opens).
 *
 * Propositions + stored chains — statements INCLUDED: unlike the prober's
 * names-only rule (its business is the map's organization), a practice agent
 * must READ the propositions to pose against them and fill `problem.target`
 * with real ids. Compactness mirrors the auditor's dump cap.
 */
export const PRACTICE_READ_GRAPH_MAX_NODES = 400;

/** The read_graph pin: compact ONE-LINE shape (id + name, no statement) —
 *  pure + exported for node-test pins. `nodeLine` below is the full-shape
 *  sibling; this stays minimal so a large map costs little context. */
export function readGraphNodeNameLine(node: Pick<GraphNode, "id" | "name">): string {
	return `- ${node.id} :: ${node.name}`;
}

/** The read_graph pin: the chain line — premise names → conclusion name
 *  (formatChainLine shape). Unknown ids fall back to the raw id (honest,
 *  never guessed). Pure + exported for node-test pins. */
export function readGraphChainLine(
	chain: Pick<import("../../core/chains.ts").ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== "" ? `- ${premises} → ${nameOf(chain.conclusion)}` : `- ${nameOf(chain.conclusion)} (no premises)`;
}

export function practitionerGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	return {
		read_graph: {
			name: "read_graph",
			label: "read_graph",
			description:
				"Read the learner's ENTIRE knowledge map for this workspace in one call — every proposition (id + name) and every stored reasoning chain (premises → conclusion). " +
				"Call it whenever a pick-less start needs grounding, or when a `problem` target must be chosen from the map. If the map is too large for one read, this tool says so — then ground through list_sessions and list_propositions.",
			parameters: Type.Object({}),
			execute: serverExecute("read_graph", Type.Object({}), async (): Promise<string> => {
				const graph = getGraph(deps.graphStore);
				if (graph.nodes.length === 0) return "The knowledge map for this workspace is empty — no proposition exists yet.";
				if (graph.nodes.length > PRACTICE_READ_GRAPH_MAX_NODES) {
					return (
						`The map is too large for one compact read (${graph.nodes.length} propositions, cap ${PRACTICE_READ_GRAPH_MAX_NODES}). ` +
						`Use list_sessions, then list_propositions per plausibly-related session.`
					);
				}
				const names = Object.fromEntries(graph.nodes.map((n) => [n.id, { name: n.name }]));
				const chainLines = chainsForSelection(
					graph.nodes.map((n) => ({ id: n.id })),
					graph.chains.map((c) => ({ id: c.id, premises: c.premises, conclusion: c.conclusion })),
				)
					.filter((c) => c.premises.length > 0)
					.map((c) => readGraphChainLine(c, names));
				const nodeLines = graph.nodes.map((n) => readGraphNodeNameLine(n));
				const parts = [
					`${graph.nodes.length} proposition(s) in the knowledge map:`,
					...nodeLines,
				];
				if (chainLines.length > 0) {
					parts.push("", `Reasoning chains (${chainLines.length}):`, ...chainLines);
				}
				return parts.join("\n");
			}),
		},
	};
}

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET — the extraction auditor explores the graph to
 * place new propositions instead of receiving it injected (owner ruling
 * 2026-09-27: a full-graph dump bloats context as the graph grows; the
 * auditor looks up identity candidates itself). Auditor-specific
 * versions, deliberately different from the prober's:
 *
 *   read_graph        ONE compact dump — every node's id + name +
 *                     statement + aliases. THE happy-path ground: the
 *                     graph is SMALL and FINITE, so one call grounds the
 *                     whole identity pass. When it refuses (a graph above
 *                     the dump cap), the auditor falls back to the per-
 *                     session reads below (2026-10-30: before this tool
 *                     existed, the auditor had to spend one turn PER
 *                     session on list_propositions — a graph with more
 *                     birth sessions than its turn budget could afford —
 *                     and exhausted the budget without ever submitting,
 *                     the "the auditor never submitted a review" failure).
 *   find              glob over node names + statements + aliases — the
 *                     targeted sweep; returns id + name + statement
 *                     (statement text is ESSENTIAL for identity work,
 *                     unlike the prober's names-only rule).
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (same reasoning as find).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

/** The read_graph dump's cap (node count). Beyond it the compact listing
 *  gets bigger than the per-session reads it replaces — honest refusal +
 *  the fallback procedure (the tool names the fallback explicitly).
 *  ~400 nodes × ~180 chars ≈ 5k tokens: a fraction of the write
 *  channel's window, and far past what any real graph stays at. */
export const AUDITOR_READ_GRAPH_MAX_NODES = 400;

/** Glob match — `*` spans anything, case-insensitive. `*needle*` is the
 *  expected shape; a bare term gets implicit surrounding stars. */
function globMatch(pattern: string, text: string): boolean {
	const raw = pattern.includes("*") ? pattern : `*${pattern}*`;
	const re = new RegExp(
		`^${raw.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "[\\s\\S]*" : `\\${ch}`))}$`,
		"i",
	);
	return re.test(text);
}

export function auditorGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object({
		query: Type.String({
			minLength: 1,
			description: "Glob pattern over node names, statements, and aliases — e.g. *will to power*. A bare term gets implicit surrounding *.",
		}),
	});
	return {
		read_graph: {
			name: "read_graph",
			label: "read_graph",
			description:
				"Read the ENTIRE knowledge graph in one call — every existing proposition: id, name, full statement, aliases. " +
				"Call this FIRST: it is the whole ground of identity candidates; nothing to link exists outside it. " +
				"If the graph is too large for one compact read, this tool says so — then fall back to list_sessions and read sessions with list_propositions.",
			parameters: Type.Object({}),
			execute: serverExecute("read_graph", Type.Object({}), async (): Promise<string> => {
				const nodes = getGraph(deps.graphStore).nodes;
				if (nodes.length === 0) return "The knowledge graph is empty — no proposition exists to link into.";
				if (nodes.length > AUDITOR_READ_GRAPH_MAX_NODES) {
					return (
						`The graph is too large for one compact read (${nodes.length} nodes, cap ${AUDITOR_READ_GRAPH_MAX_NODES}). ` +
						`Use list_sessions, then list_propositions per plausibly-related session, and find for targeted sweeps.`
					);
				}
				const lines = nodes.map((n) => {
					const aliases = n.aliases.length > 0 ? ` | aliases: ${n.aliases.join("; ")}` : "";
					return `- ${n.id} :: ${n.name} :: ${n.statement}${aliases}`;
				});
				return `${nodes.length} proposition(s) in the graph — the complete ground:\n${lines.join("\n")}`;
			}),
		},
		find: {
			name: "find",
			label: "find",
			description:
				"Search the knowledge graph for existing propositions — glob over names, statements, and aliases. " +
				"Returns each match's id, name, full statement, and the session(s) it was born in (a list_propositions id). " +
				"This is how you decide whether a new proposition IS an existing one: search its key words, its synonyms, its phrasings.",
			parameters: findInput,
			execute: serverExecute("find", findInput, async ({ query }): Promise<string> => {
				const nodes = getGraph(deps.graphStore).nodes;
				const hits = nodes.filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No existing proposition matches "${query}".`;
				// BORN-IN POINTER (owner, 2026-09-29): a hit names its birth
				// session(s) — find results now compose with list_propositions
				// (read the whole session the hit came from) instead of being
				// dead ends. Legacy no-provenance nodes name none.
				const lines = hits.map((n) => {
					const born = [...new Set(n.provenance.map((pt) => pt.chatId))];
					return (
						`- ${n.id} :: ${n.name}\n  statement: ${n.statement}` +
						(born.length > 0 ? `\n  born in: ${born.join(", ")}` : "")
					);
				});
				return `${hits.length} match(es):\n${lines.join("\n")}`;
			}),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the knowledge graph's birth sessions — every chat or imported-notes file that ever contributed a proposition. " +
				"Each line: name, kind, proposition count, id. Use the id with list_propositions to see what a session covered.",
			parameters: Type.Object({}),
			execute: serverExecute("list_sessions", Type.Object({}), async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}) — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one session, with FULL statement text — the content-level view for identity work " +
				"(deciding whether a new proposition is really one of these).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const lines = propositions.map((p) => {
					const node = nodes.get(p.nodeId);
					return `- ${p.nodeId} :: ${p.name}\n  statement: ${node?.statement ?? "(unknown)"}`;
				});
				return `${propositions.length} proposition(s) born in this session:\n${lines.join("\n")}`;
			}),
		},
	};
}
