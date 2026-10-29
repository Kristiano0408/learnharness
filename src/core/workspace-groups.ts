/**
 * Workspace grouping — the sidebar's section fold (workspace wave Phase 3,
 * owner decisions 2026-10-28, docs/workspaces.md).
 *
 * Pure core (browser-safe, no IO): the sidebar owns localStorage and the
 * fetches; this module owns the two folds the render must not re-derive:
 *
 *   groupChatsByWorkspace — sessions → sections (Unsorted first, then the
 *   workspaces in store order). A chat filed under a workspace that no
 *   longer exists (the create/delete race a stale client can carry) reads
 *   as Unsorted — honest, never dropped.
 *
 *   The per-section kind filter (owner decision 4C): a map
 *   sectionKey → SessionKindFilter with a "*" default entry. The legacy
 *   single-string value (the pre-workspace global filter) migrates lazily
 *   on read: it becomes the "*" default, so untouched sections keep the
 *   behavior the user had.
 */

import type { ChatKind } from "./contracts.ts";

/** The section key for sessions without a workspaceId. */
export const UNSORTED_KEY = "unsorted";
/** The kind-filter map's default entry (sections without an explicit pick). */
export const FILTER_DEFAULT_KEY = "*";
/** The draft's filing default (workspace wave Phase 3): the last workspace
 *  the learner picked in the draft's chip; absent = Unsorted. */
export const DRAFT_WORKSPACE_KEY = "lh:draft-workspace";

/** The three-way session-kind filter (moved from components/sidebar.tsx —
 *  the fold and its type now live together in core). */
export type SessionKindFilter = "teach" | "all" | "practice";

const KIND_FILTERS: readonly SessionKindFilter[] = ["teach", "all", "practice"];

/** Minimal structural views of the list items — the fold never needs more
 *  than these fields, so it stays testable with tiny fixtures. */
export interface ChatLike {
	workspaceId?: string;
	kind?: ChatKind;
}
export interface WorkspaceLike {
	id: string;
	name: string;
}

export interface SessionSection<C extends ChatLike> {
	/** Workspace id, or UNSORTED_KEY. */
	key: string;
	/** "Unsorted" or the workspace's name. */
	name: string;
	workspaceId: string | null;
	/** The section's chats, in the incoming list order (updatedAt desc —
	 *  the order inside a section is today's order, unchanged). */
	chats: C[];
}

/** Sessions → sections. Unsorted FIRST (only when it holds chats — an
 *  empty Unsorted section is noise), then every workspace in the given
 *  order (createdAt — the store's stable order), INCLUDING empty ones (a
 *  workspace the learner created deliberately stays visible). */
export function groupChatsByWorkspace<C extends ChatLike>(
	chats: readonly C[],
	workspaces: readonly WorkspaceLike[],
): SessionSection<C>[] {
	const known = new Set(workspaces.map((w) => w.id));
	const unsorted: C[] = [];
	const perWorkspace = new Map<string, C[]>();
	for (const chat of chats) {
		const id = chat.workspaceId !== undefined && known.has(chat.workspaceId) ? chat.workspaceId : null;
		if (id === null) {
			unsorted.push(chat);
		} else {
			const bucket = perWorkspace.get(id);
			if (bucket) bucket.push(chat);
			else perWorkspace.set(id, [chat]);
		}
	}
	const sections: SessionSection<C>[] = [];
	if (unsorted.length > 0) sections.push({ key: UNSORTED_KEY, name: "Unsorted", workspaceId: null, chats: unsorted });
	for (const workspace of workspaces) {
		sections.push({ key: workspace.id, name: workspace.name, workspaceId: workspace.id, chats: perWorkspace.get(workspace.id) ?? [] });
	}
	return sections;
}

/** Read the persisted kind-filter map. The legacy pre-workspace value is
 *  a bare filter string ("teach"/"all"/"practice") — it migrates lazily to
 *  the "*" default. Corrupt/unknown reads as {} (every section defaults). */
export function readKindFilters(raw: string | null): Record<string, SessionKindFilter> {
	if (raw === null) return {};
	if (isKindFilter(raw)) return { [FILTER_DEFAULT_KEY]: raw };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const out: Record<string, SessionKindFilter> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (isKindFilter(value)) out[key] = value;
			}
			return out;
		}
	} catch {
		/* corrupt → defaults */
	}
	return {};
}

export function writeKindFilters(filters: Record<string, SessionKindFilter>): string {
	return JSON.stringify(filters);
}

/** A section's filter: its explicit pick, else the "*" default, else "all"
 *  (today's default — absence never changes behavior). */
export function kindFilterFor(filters: Record<string, SessionKindFilter>, key: string): SessionKindFilter {
	return filters[key] ?? filters[FILTER_DEFAULT_KEY] ?? "all";
}

/** Immutably set one section's filter. */
export function withKindFilter(
	filters: Record<string, SessionKindFilter>,
	key: string,
	value: SessionKindFilter,
): Record<string, SessionKindFilter> {
	return { ...filters, [key]: value };
}

/** The kind filter over one section's chats (normalized kind: absent reads
 *  as teach — the ChatSummary contract). */
export function filterChatsByKind<C extends ChatLike>(chats: readonly C[], filter: SessionKindFilter): C[] {
	if (filter === "all") return [...chats];
	return chats.filter((c) => (c.kind ?? "teach") === filter);
}

function isKindFilter(value: unknown): value is SessionKindFilter {
	return typeof value === "string" && (KIND_FILTERS as readonly string[]).includes(value);
}
