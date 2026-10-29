/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore, createGraphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { workspaceStore } from "../store/workspaces.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { WORKSPACE_GRAPH_REFUSAL } from "../core/workspace-refusal.ts";
import { graphFilesForDir, workspaceGraphDir } from "../../config.ts";
import type { GraphStore } from "../core/ports.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
	workspaceStore,
};

export type Stores = typeof stores;

/**
 * THE per-workspace graph store (workspace wave Phase 4, docs/workspaces.md
 * decision 1B): each workspace's own ledger family lives INSIDE its folder
 * (data/workspaces/<id>/graph/, decision 8) and gets ONE store instance —
 * created here, the composition root (no caller builds stores). The legacy
 * global `stores.graphStore` (data/graph/) stays untouched beside it
 * (decision 9): Unsorted sessions have NO graph destination — their store
 * is the refusing no-op below. A workspace id resolves through the workspace
 * store; an unknown id refuses honestly like every other absent-record read.
 */
const graphStores = new Map<string, GraphStore>();

export function graphStoreFor(workspaceId: string): GraphStore {
	const cached = graphStores.get(workspaceId);
	if (cached) return cached;
	// The workspace store owns the shape guard (WORKSPACE_ID_PATTERN at
	// mint); resolve through it — an id this build can't back means the
	// caller held an id no store ever minted.
	const record = workspaceStore.getWorkspace(workspaceId);
	if (!record) throw new Error(`No such workspace: ${workspaceId}`);
	const created = createGraphStore(graphFilesForDir(workspaceGraphDir(record.id)));
	graphStores.set(record.id, created);
	return created;
}

/** THE refusing no-op store (decision 9): a session WITHOUT a workspace has
 *  no graph destination. Reads stay empty — honest "nothing yet" (the same
 *  shape an empty workspace's store reads as); writes refuse loudly so a
 *  mis-wired caller never silently writes where nothing can be read back. */
function refusedStore(what: string): GraphStore {
	const refuse = (): never => {
		throw new Error(`${what} ${WORKSPACE_GRAPH_REFUSAL}`);
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

export type GraphStoreResolver = {
	/** The store for one CHAT (the extraction/turn callers): fresh read of the
	 *  record — a session born without a workspaceId keeps no graph; a moved
	 *  session lands on its new workspace's store. A vanished chat resolves
	 *  refused (the pipeline's per-batch liveness guard owns that case). */
	forChat(chatId: string): GraphStore | null;
	/** The store for one WORKSPACE id (graph view / import / move orchestration). */
	forWorkspace(workspaceId: string | null): GraphStore;
};

/** THE READ side of the seam (Phase 4): where a session's graph DATA lives.
 *  A session WITHOUT a workspaceId rides the legacy global store — not the
 *  refusing no-op: pre-Phase-4 unsorted sessions wrote their traces into
 *  data/graph/ before the workspace wave existed (decision 9 forbids NEW
 *  writes there, never reads). A workspace session reads its own store; a
 *  vanished chat is null (caller owns that case). */
export function graphStoreForChatRead(chatId: string): GraphStore | null {
	const record = chatStore.getChat(chatId);
	if (!record) return null;
	// THE READ side of the seam (Phase 4, decision 9): a session WITHOUT a
	// workspaceId reads the LEGACY global store — pre-Phase-4 unsorted sessions
	// wrote their traces into data/graph/ before the workspace wave existed
	// (decision 9 forbids NEW writes there, never reads). A workspace session
	// reads its own store; a vanished chat is null (caller owns that case).
	return record.workspaceId === undefined ? graphStore : graphStoreFor(record.workspaceId);
}

/** The single resolver the server band injects into the pipeline and routes. */
export const graphStoresForChat = {
	forChat(chatId: string): GraphStore | null {
		const record = chatStore.getChat(chatId);
		if (!record) return null;
		// THE READ side of the seam (Phase 4, decision 9): a session WITHOUT a
		// workspaceId rides the LEGACY global store on the read path —
		// pre-Phase-4 unsorted sessions wrote their traces into data/graph/
		// before the workspace wave existed. A moved workspace session reads its
		// own store; an UNSORTED session's WRITE destination is refused: no new
		// writes land in the legacy graph (the pipeline's refusal seam owns it).
		return record.workspaceId === undefined ? refusedStore(`Session ${chatId}`) : graphStoreFor(record.workspaceId);
	},
	forWorkspace(workspaceId: string | null): GraphStore {
		return workspaceId === null ? refusedStore("Unsorted") : graphStoreFor(workspaceId);
	},
} satisfies GraphStoreResolver;
/** THE purge seam (Phase 4, decision 8): a deleted workspace's graph directory
 *  dies with it — its store instance is dropped, the directory is gone. The
 *  server band's workspace-delete route calls this BEFORE deleting the folder;
 *  an unknown id stays silent (the present-entry law). */
export function purgeWorkspaceGraphStore(workspaceId: string): void {
	graphStores.delete(workspaceId);
}
/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
