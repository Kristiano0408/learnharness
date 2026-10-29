/**
 * Workspace contracts — the session-grouping containers
 * (workspace wave, owner decisions 2026-10-28, docs/workspaces.md)
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */

// ─── Workspace records (the store's on-disk format) ──────────────────────────

/** One workspace: data/workspaces/<id>/meta.json. A workspace groups
 *  sessions and owns its own knowledge graph (data/workspaces/<id>/graph/ —
 *  the seam wired in Phase 4); a session WITHOUT a workspaceId is
 *  "Unsorted" and carries no graph destination (the legacy global graph at
 *  data/graph/ stays where it is, unread-by-new-sessions — a future
 *  cross-workspace link, decision 9). Absence is the whole migration story:
 *  pre-workspace records never migrate, absence reads as Unsorted (same
 *  regime as ChatRecord.kind). */
export interface WorkspaceRecord {
	/** "ws_" + ts36 + rand8 — the chat-id idiom (store-assigned). */
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	/** RESERVED (decision 7): a real existing folder the workspace will
	 *  open, with its files already inside, in a future wave. Absent =
	 *  purely logical workspace. Never read by current code. */
	rootPath?: string;
	/** RESERVED (decision 9): future links between workspaces (graph
	 *  cross-references). Never read by current code. */
	linkedWorkspaceIds?: string[];
	/** SCHEMA STAMP — the same lazy regime as ChatRecord.version: absence
	 *  reads as v1; every write stamps the current version; a record
	 *  stamped NEWER than this build (the downgrade scenario) is REFUSED
	 *  on read — a read-modify-write store must never rewrite what it
	 *  doesn't understand. */
	version?: number;
}

/** The workspace record format this build writes and understands. */
export const CURRENT_WORKSPACE_VERSION = 1;

/** The list view's shape: the record's public fields + the server-folded
 *  sessionCount. The fold lives in the route (chatStore.listChats is the
 *  session source — the workspace store never sees chats, import law), so
 *  the store's listWorkspaces returns the full records and the route maps
 *  them to this. */
export interface WorkspaceSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	/** Sessions carrying this workspaceId (folded server-side, Phase 2). */
	sessionCount: number;
}

/** The sidebar's workspace row: a summary + live liveness, the ChatListItem
 *  pattern — the store can't see liveness (import law), the route merges it
 *  from the turn-liveness registry. busyCount = sessions of this workspace
 *  with a teach turn in flight (the workspace header's quiet signal; a
 *  running spinner per session row already exists inside the section). */
export interface WorkspaceListItem extends WorkspaceSummary {
	busyCount: number;
}
