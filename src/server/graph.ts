import * as fs from "node:fs";
import { PATHS, graphFilesForDir, workspaceGraphDir } from "../../config.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { graphStoresForChat, stores } from "./stores.ts";
import type { GraphStore } from "../core/ports.ts";
import { callCost } from "./pricing.ts";

// ─── the honest empty read (Phase 6) ──────────────────────────────────────────

/** THE refusing no-op read shape — the composition root's refused-store reads
 *  are empty ("nothing yet"), writes refuse loudly. An unknown-but-valid
 *  workspace id rides the same honest emptiness on the READ band; a write
 *  through this shape can't happen here (reads only). Exported nowhere: it
 *  exists to keep every scoped read total. */
function refusedReadStore(): GraphStore {
	const refuse = (): never => {
		throw new Error("unknown workspace — no graph to serve");
	};
	return {
		refused: true,
		appendNode: refuse,
		appendChain: refuse,
		appendCheckpoint: refuse,
		appendCoverage: refuse,
		upsertSource: refuse,
		appendSourceUsage: refuse,
		writePositions: refuse,
		rewriteLedgers: refuse,
		readNodes: () => [],
		readChains: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
	};
}

/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 *
 * THE WORKSPACE SELECTOR (Phase 6, decision C1): undefined/"global" = the
 * legacy global graph (data/graph/, today's default); a workspace id = that
 * workspace's own ledgers. An unknown id reads as an empty graph — honest
 * "nothing yet" (the route gates 404 before this call).
 */
/** THE graph store for one workspace selector on the READ band: absent/"global"
 *  = legacy; a known workspace = its own store; an unknown-but-valid id = the
 *  honest empty read (never a throw — the route's syntactic gate and this
 *  existence gate together keep every scoped read total). */
function scopedReadStore(workspaceId: string | undefined): GraphStore {
	if (workspaceId === undefined || workspaceId === "global") return stores.graphStore;
	return stores.workspaceStore.getWorkspace(workspaceId) ? graphStoresForChat.forWorkspace(workspaceId) : refusedReadStore();
}

export function graphView(workspaceId?: string): GraphSnapshot {
	return graphSnapshot({ chatStore: stores.chatStore, graphStore: scopedReadStore(workspaceId) });
}

/** The graph view's cost surface (GET /api/graph/costs — the 2026-09 cost
 *  pill): fold every usage channel into stage totals + recent runs. A pure
 *  read over the chat records (chat-front-door runs), the notes sources
 *  (notes-front-door runs), and the naming ledger (graph-global runs);
 *  dollars are inferred by the pure core fold (core/cost-summary.ts +
 *  prices.ts) — nothing here stores or caches money. */
export function graphCosts(workspaceId?: string): GraphCostSummary {
	const chats = stores.chatStore
		.listChats()
		.flatMap((summary) => {
			const record = stores.chatStore.getChat(summary.id);
			return record?.extractions?.length
				? [{ title: record.title ?? summary.id, extractions: record.extractions }]
				: [];
		});
	const graph = scopedReadStore(workspaceId);
	const sources = graph
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** The graph's version stamp (session-deletion wave 6): the max mtime
 * across every graph data file — ledgers, positions. Moves on ANY
 * graph write (merge append, settle, or a deletion's atomic rewrite),
 * never moves on reads, and needs no bookkeeping of its own: the fs
 * IS the counter. Consumers poll it (the activity feed
 *  carries it; the DELETE response returns it) to know clusters/layout
 *  must refetch — the "graph changed underneath me" signal.
 *
 * THE WORKSPACE SELECTOR (Phase 6): absent/"global" = the legacy global
 * graph's stamp (today's default, byte-identical pre-Phase-6 behavior);
 * a workspace id = that workspace directory's stamp. An unknown id reads
 * 0 — honest "nothing yet". */
export function graphRevision(scope?: string): number {
	// THE WORKSPACE SELECTOR (Phase 6): absent = the legacy global graph's
	// stamp (today's default, byte-identical pre-Phase-6 behavior); a
	// workspace id = that workspace directory's stamp. An unknown id reads 0
	// — honest "nothing yet".
	const dir = scope === undefined ? PATHS.graph : workspaceGraphDir(scope);
	const files = graphFilesForDir(dir);
	let revision = 0;
	for (const file of [
		files.nodes,
		files.chains,
		files.sessions,
		files.coverage,
		files.positions,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). The guard family is deliberately NOT the chat
 * one, and the reasoning is worth writing down:
 *
 *   - No turn/jobs gates. Turns and background jobs never write the
 *     graph ledgers; a turn's follow-up extraction registers as a run,
 *     and every code path here is synchronous — nothing can register
 *     or merge between the gate and the ledger rewrite (the event loop
 *     never yields inside this function).
 *   - THE EXTRACTION GATE — 409 while ANY pipeline run is registered,
 *     anywhere. A mid-flight run holds findings extracted from
 *     transcripts that predate the deletion; its merges could re-add
 *     aliases, provenance, or events to the dying node (the
 *     re-reference risk the dispatch flags). Unlike chat deletion we
 *     do NOT abort the run: it belongs to some session, and killing
 *     that session's spend is outside this deletion's blast radius —
 *     the UI retries once the dock drains. A run that starts AFTER
 *     the deletion is legitimate re-learning: it reads post-deletion
 *     ledgers, mints a fresh node for a re-taught topic, and
 *     mergeFindings ignores linkTo ids that no longer exist (the
 *     existingIds guard) — no dangling edges, no resurrection.
 */
export function deleteGraphNode(nodeId: string, workspaceId?: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the
	// rewrite are one atomic stretch of the event loop.
	// THE WORKSPACE SELECTOR (Phase 6): the node dies in the graph directory
	// the view is showing — absent/legacy = data/graph/ (today's default),
	// workspace id = that workspace's ledgers. An unknown-but-valid id reads
	// the honest empty store: no node there → the 404 below, never a throw.
	const graph = scopedReadStore(workspaceId);
	const stats = deleteNodeTraces(graph, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision(workspaceId) };
}

