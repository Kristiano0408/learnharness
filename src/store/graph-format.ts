/**
 * The graph-family FORMAT STAMP (schema-versioning wave, owner 2026-10-10):
 * data/graph/format.json — one sidecar versioning the whole graph dir
 * family (the four JSONL ledgers, sources.json, render-settings.json).
 * JSONL ledgers can't carry inline stamps without per-line bloat, and the
 * JSON files share the family's fate, so the stamp lives beside them.
 * positions.json is rebuildable (owner ruling) and needs no protection.
 *
 * The contract:
 *  - LAZY v1: NO sidecar = v1 (the pre-stamp world stays valid forever);
 *    the first graph-family WRITE creates it. Reads never write.
 *  - Honest refusal (owner: refuse-honestly ruling): a sidecar stamped
 *    NEWER than this build (the downgrade scenario — user reverted the
 *    app) makes graph-family reads THROW. Read-modify-write stores must
 *    never rewrite what they don't understand; a ledger store must never
 *    silently skip lines it can't interpret as current-format data.
 *
 * Version constants: contracts/graph.ts CURRENT_GRAPH_FORMAT_VERSION.
 *
 * Per-directory since the workspace wave Phase 4 (2026-10-29): the stamp
 * takes a GraphFiles host (config.ts) instead of the module constant — each
 * graph family directory (the legacy global `data/graph/` AND every
 * workspace's own dir, docs/workspaces.md decision 8) carries its OWN
 * sidecar. A newer-stamped workspace never gates another graph dir's reads.
 */

import fs from "node:fs";
import path from "node:path";
import { GRAPH_FORMAT_FILE, type GraphFiles } from "../../config.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";

/** The stamp sidecar of one graph family (config GraphFiles.format). */
export type FormatHost = Pick<GraphFiles, "format">;
/** A full graph-family directory — every host a GraphFiles is a valid FormatHost. */
type Host = Pick<GraphFiles, "format">;

function stampedVersion(host: Host): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(host.format, "utf-8");
	} catch {
		return null; // no sidecar — the lazy-v1 pre-stamp world
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // corrupt sidecar reads as unstamped (v1), not fatal
	}
}

/** READ-SIDE GUARD: throws when the data dir was written by a NEWER build.
 *  Called by every graph-family read — never writes (the golden fixtures
 *  pin reads as byte-identical). */
export function assertGraphFormat(host: Host): void {
	const v = stampedVersion(host);
	if (v !== null && v > CURRENT_GRAPH_FORMAT_VERSION) {
		throw new Error(
			`Graph data is stamped with format version ${v}, but this build understands only ${CURRENT_GRAPH_FORMAT_VERSION}. ` +
				"The app is older than its data — upgrade the app before touching the knowledge map.",
		);
	}
}

/** WRITE-SIDE STAMP: creates the sidecar on the first graph-family write
 *  (lazy); afterwards a no-op existence-wise. Callers keep their own mkdir. */
export function ensureGraphFormat(host: Host): void {
	if (stampedVersion(host) !== null) return;
	fs.mkdirSync(path.dirname(host.format), { recursive: true });
	fs.writeFileSync(host.format, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n", "utf-8");
}

/** The legacy global graph dir's host — the module constants (GRAPH_FORMAT_FILE
 *  et al.) still name it; every GraphFiles-bound call passes its own files. */
export const LEGACY_GRAPH_HOST: FormatHost = { format: GRAPH_FORMAT_FILE };
