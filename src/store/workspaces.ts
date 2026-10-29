/**
 * WorkspaceStore — the fs JSON adapter (one directory per workspace in
 * data/workspaces/, the record in <id>/meta.json).
 *
 * Implements core/ports.ts WorkspaceStore; the record shape lives in
 * core/contracts/workspace.ts (WorkspaceRecord). Idioms mirror
 * src/store/chats.ts: sync fs, tiny records, id-guarded paths, JSON with
 * tab indentation, lazy version stamping (absence reads as v1, every write
 * stamps CURRENT_WORKSPACE_VERSION, a newer stamp refuses on read).
 * Wired in the composition root (src/server/stores.ts); nothing else
 * constructs it.
 *
 * EVENT LAW (the chats-changed silence law, same discipline — workspace
 * wave 2026-10-28): workspaces-changed announces ONLY list-SHAPE
 * mutations — createWorkspace, renameWorkspace, deleteWorkspace (each
 * emits post-write). Phase 4's per-workspace graph writes are separate
 * channels; this store has no content writers yet, so everything it does
 * announces.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { WorkspaceStore } from "../core/ports.ts";
import type { WorkspaceRecord } from "../core/contracts.ts";
import { CURRENT_WORKSPACE_VERSION } from "../core/contracts.ts";

function workspaceDir(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid workspace id: ${id}`);
	return path.join(PATHS.workspaces, id);
}

function metaFile(id: string): string {
	return path.join(workspaceDir(id), "meta.json");
}

function createWorkspace(name: string): WorkspaceRecord {
	const now = new Date().toISOString();
	const record: WorkspaceRecord = {
		id: `ws_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		name: name.trim() || "Untitled workspace",
		createdAt: now,
		updatedAt: now,
	};
	fs.mkdirSync(PATHS.workspaces, { recursive: true });
	writeWorkspace(record);
	emit("workspaces-changed", {});
	return { ...record, version: CURRENT_WORKSPACE_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT: every record persist goes through here and
 *  carries the CURRENT version stamp — lazy migration means existing
 *  records only get stamped on their next write (the chat-store law). */
function writeWorkspace(record: WorkspaceRecord): void {
	// The workspace owns a DIRECTORY (meta.json + Phase 4's graph/), so the
	// choke point creates it — mkdir recursive is idempotent.
	fs.mkdirSync(workspaceDir(record.id), { recursive: true });
	fs.writeFileSync(metaFile(record.id), JSON.stringify({ ...record, version: CURRENT_WORKSPACE_VERSION }, null, "\t"), "utf-8");
}

function getWorkspace(id: string): WorkspaceRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(metaFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (the downgrade scenario, same as chats.getChat): a
	// record stamped NEWER than this build reads as absent, never
	// misparsed — the next read-modify-write must not rewrite what it
	// doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_WORKSPACE_VERSION) {
		console.error(`[workspace ${id}] record stamped with schema version ${v} > ${CURRENT_WORKSPACE_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	if (!isWorkspaceRecord(parsed)) return null; // corrupt shape: absent, never guessed at
	return parsed;
}

/** Strict shape guard — anything not matching the WorkspaceRecord shape is
 *  skipped (the graph-store doctrine: the ledgers are the source of truth,
 *  corrupt entries read as absent). */
function isWorkspaceRecord(v: unknown): v is WorkspaceRecord {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as WorkspaceRecord).id === "string" &&
		typeof (v as WorkspaceRecord).name === "string" &&
		typeof (v as WorkspaceRecord).createdAt === "string" &&
		typeof (v as WorkspaceRecord).updatedAt === "string"
	);
}

function listWorkspaces(): WorkspaceRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(PATHS.workspaces);
	} catch {
		return []; // no workspace has ever been created
	}
	return names
		.map((name) => getWorkspace(name))
		.filter((r): r is WorkspaceRecord => r !== null)
		// Oldest first — stable sidebar order. The id tiebreak keeps the order
		// deterministic when two workspaces share a createdAt millisecond.
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Rename a workspace. Like renameChat: a rename is NOT activity —
 *  updatedAt stays put, so list order never churns. Same fallback as
 *  createWorkspace — the empty string becomes "Untitled workspace" (the
 *  API gate rejects it first; this is the honest floor for any caller). */
function renameWorkspace(id: string, name: string): WorkspaceRecord {
	const record = getWorkspace(id);
	if (!record) throw new Error(`Workspace not found: ${id}`);
	record.name = name.trim() || "Untitled workspace";
	writeWorkspace(record);
	emit("workspaces-changed", {});
	return record;
}

/** Delete the workspace directory entirely (meta.json + whatever lives
 *  inside — Phase 4's graph/ rides along by design). False when the id is
 *  unknown — the route turns that into a 404. Session orphaning is the
 *  route's choreography (the v1 gate refuses a non-empty workspace,
 *  docs/workspaces.md Phase 2), not the store's. */
function deleteWorkspace(id: string): boolean {
	try {
		// rmSync(force) swallows ENOENT — the present-entry law needs a real
		// answer: an id that never existed must stay silent and return false.
		if (!fs.existsSync(metaFile(id))) return false;
		fs.rmSync(workspaceDir(id), { recursive: true, force: true });
		emit("workspaces-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // unreadable, or an invalid id the guard refused — same answer
	}
}

export const workspaceStore: WorkspaceStore = {
	createWorkspace,
	getWorkspace,
	listWorkspaces,
	renameWorkspace,
	deleteWorkspace,
};
