/**
 * Server-side workspace entries for the transport layer (app/api/workspaces*,
 * app/api/chats* filing gates) — workspace wave Phase 2, docs/workspaces.md.
 *
 * The thin part of the seam: the store port does the records, this module
 * owns the two folds the store must never see (sessionCount over the chat
 * store, busyCount over the turn-liveness registry — the ChatListItem
 * pattern) and the validation gates the store deliberately leaves open
 * (a workspaceId must name an existing workspace; a workspace delete
 * refuses a non-empty workspace, v1).
 */

import { extractionStatuses } from "../agent/subagents/extraction.ts";
import {
	landChatTraces,
	takeChatTraces,
	type ChatMoveMode,
	type ChatMoveStats,
} from "../core/graph-deletion.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { graphRevision } from "./graph.ts";
import { graphStoreForChatRead, graphStoresForChat, purgeWorkspaceGraphStore, stores } from "./stores.ts";
import type { WorkspaceListItem } from "../core/contracts.ts";

export const { createWorkspace, getWorkspace, listWorkspaces, renameWorkspace, deleteWorkspace } =
	stores.workspaceStore;

/** The sidebar's workspace list: records + the two server folds (the
 *  store's listWorkspaces stays record-only — sessionCount/busyCount are
 *  route-side, import law). Oldest-first order rides through (the store's
 *  createdAt order is the sidebar's section order). */
export function listWorkspaceItems(): WorkspaceListItem[] {
	const chats = stores.chatStore.listChats();
	return listWorkspaces().map((record) => {
		const own = chats.filter((c) => c.workspaceId === record.id);
		return {
			id: record.id,
			name: record.name,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			sessionCount: own.length,
			busyCount: own.filter((c) => isTurnRunning(c.id)).length,
		};
	});
}

/** The filing gate (POST /api/chats + PUT /api/chats/[id]/workspace): a
 *  workspaceId must name an existing workspace. The store accepts what it
 *  is given (validation-split law); this is where the HTTP 400 lands. */
export function workspaceExists(id: string): boolean {
	return stores.workspaceStore.getWorkspace(id) !== null;
}

/** What moveChatSession did — the route maps it straight to HTTP. */
export type ChatMoveOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 400; code: "unknown_workspace"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "extraction_running"; error: string }
	| { ok: true; workspaceId: string | null };

/** Move a session between workspaces (docs/workspaces.md Phase 2).
 *  GATES first, same discipline as deleteChatSession: a turn in flight
 *  persists the record read-modify-write at settle, and an extraction run
 *  appends its usage the same way — a filing write racing either would be
 *  clobbered (or would clobber them). Both refuse with a retryable 409.
 *  The graph-trace transport (mode=move-nodes, Phase 5) builds on this
 *  same gate. */
export function moveChatSession(chatId: string, workspaceId: string | null): ChatMoveOutcome {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	if (workspaceId !== null && !workspaceExists(workspaceId)) {
		return { ok: false, status: 400, code: "unknown_workspace", error: `No such workspace: ${workspaceId}` };
	}
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
		};
	}
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "This session's extraction is still running — try again when it finishes",
		};
	}
	const record = stores.chatStore.moveChat(chatId, workspaceId);
	return { ok: true, workspaceId: record.workspaceId ?? null };
}

/** What moveChatSessionGraph did (Phase 5) — the route maps it straight to
 *  HTTP. The move-nodes success carries what left and landed plus the two
 *  revised stamps (origin/destination), the refetch signal for both graphs
 *  — the delete response's pattern. */
export type ChatMoveGraphOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 400; code: "unknown_workspace" | "bad_mode" | "no_graph_destination"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "extraction_running"; error: string }
	| {
			ok: true;
			mode: ChatMoveMode;
			workspaceId: string | null;
			stats: ChatMoveStats | null;
			originGraphRevision: number | null;
			originScope: string | null;
			destinationGraphRevision: number | null;
			destinationScope: string | null;
	  };

/**
 * Move a session, optionally WITH its graph traces (docs/workspaces.md
 * Fase 5, the A3 dialog's second mode). The gate family is EXACTLY
 * moveChatSession's — the same retryable 409s — plus one destination rule:
 * Unsorted has no graph destination (decision 9), so `mode=move-nodes`
 * toward an Unsorted target refuses 400 honestly rather than silently
 * dropping the traces.
 *
 * The choreography (the wave-6 atomicity argument, unchanged): gates →
 * fresh origin/destination resolution → ONE synchronous block — take the
 * origin's delta, land it on the destination, move the chat record LAST.
 * A crash between the two graph writes leaves nothing resurrected: the
 * session's coverage rows are gone from both graphs (land appends them at
 * the destination), and a next extraction re-covers against the destination
 * ledger — idempotent. The origin rewrite is atomic per store (tmp+rename).
 *
 * ORIGIN RESOLVED BY THE READ SEAM: a pre-Phase-4 unsorted session's traces
 * live in the legacy global graph (data/graph/) — decision 9 forbids NEW
 * writes there, never rewrites of EXISTING rows; `takeChatTraces` only ever
 * REMOVES this session's rows from it. A workspace origin rides its own
 * store. Unsorted-with-no-traces carries nothing (the honest empty delta).
 */
export function moveChatSessionGraph(
	chatId: string,
	mode: ChatMoveMode,
	workspaceId: string | null,
): ChatMoveGraphOutcome {
	if (mode !== "move-session" && mode !== "move-nodes") {
		return { ok: false, status: 400, code: "bad_mode", error: 'mode must be "move-session" or "move-nodes"' };
	}
	const record = stores.chatStore.getChat(chatId);
	if (!record) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	if (workspaceId !== null && !workspaceExists(workspaceId)) {
		return { ok: false, status: 400, code: "unknown_workspace", error: `No such workspace: ${workspaceId}` };
	}
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
		};
	}
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "This session's extraction is still running — try again when it finishes",
		};
	}
	if (mode === "move-nodes" && workspaceId === null) {
		return {
			ok: false,
			status: 400,
			code: "no_graph_destination",
			error: "Unsorted has no graph — move the session without its traces instead",
		};
	}

	// THE SYNC BLOCK — no awaits below (see the doc comment). Order: origin
	// take → destination land → the chat record LAST (a crash mid-block never
	// leaves a moved chat with traces in BOTH graphs or in NEITHER).
	const originId = record.workspaceId ?? null;
	if (mode === "move-session" || originId === workspaceId) {
		const moved = stores.chatStore.moveChat(chatId, workspaceId);
		return {
			ok: true,
			mode,
			workspaceId: moved.workspaceId ?? null,
			stats: null,
			originGraphRevision: null,
			originScope: null,
			destinationGraphRevision: null,
			destinationScope: null,
		};
	}

	// The origin store resolved by the READ seam — legacy graph for an
	// unsorted session, own store for a workspace one. (A refused store can't
	// happen on the read path; the honest guard stays anyway.)
	const origin = graphStoreForChatRead(chatId);
	if (origin === null || origin.refused === true) {
		return { ok: false, status: 400, code: "no_graph_destination", error: "This session has no graph traces to move" };
	}
	const destination = graphStoresForChat.forWorkspace(workspaceId);

	const { delta, stats } = takeChatTraces(origin, chatId);
	landChatTraces(destination, chatId, delta);
	const moved = stores.chatStore.moveChat(chatId, workspaceId);

	// Phase 6 scope pinning: each stamp names the graph directory it was read
	// from — an unsorted origin rode the legacy global graph (null scope), a
	// workspace origin its own; the destination of a move-nodes transport is
	// always a workspace (the gate above refuses Unsorted), never null.
	return {
		ok: true,
		mode,
		workspaceId: moved.workspaceId ?? null,
		stats,
		originGraphRevision: graphRevision(originId ?? undefined),
		originScope: originId,
		destinationGraphRevision: graphRevision(workspaceId ?? undefined),
		destinationScope: workspaceId,
	};
}

/** What deleteWorkspaceSessionGate did — the route maps it straight to HTTP.
 *  v1 (docs/workspaces.md Phase 2): a workspace with sessions refuses —
 *  moving or deleting its sessions first is the owner's call, not a
 *  cascade the server makes silently. */
export type WorkspaceDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "not_empty"; error: string; sessionCount: number }
	| { ok: true };

export function deleteWorkspaceGuarded(id: string): WorkspaceDeleteOutcome {
	if (!getWorkspace(id)) {
		return { ok: false, status: 404, code: "not_found", error: "No such workspace" };
	}
	const sessionCount = stores.chatStore.listChats().filter((c) => c.workspaceId === id).length;
	if (sessionCount > 0) {
		return {
			ok: false,
			status: 409,
			code: "not_empty",
			error: `This workspace still holds ${sessionCount} session${sessionCount === 1 ? "" : "s"} — move or delete them first`,
			sessionCount,
		};
	}
	// THE WORKSPACE GRAPH (Phase 4, decision 8): a deleted workspace's graph
	// directory dies with it — the cached store instance is dropped FIRST, so
	// no later resolver call can re-bind (and re-mint) a deleted directory.
	purgeWorkspaceGraphStore(id);
	deleteWorkspace(id);
	return { ok: true };
}
