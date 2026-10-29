/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers of ONE graph
 * directory (config GraphFiles — src/store/graph.ts factory since the
 * workspace wave Phase 4, docs/workspaces.md).
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, per-directory at factory creation (same
 * doctrine as the events-ledger purge below).
 *
 * Plus sources.json (in the same directory): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * PER-DIRECTORY SEAM (Phase 4): createGraphStore(files) mints one store
 * instance bound to ONE GraphFiles directory — the legacy global graph
 * (data/graph/, decision 9: stays where it is, read-only for new sessions)
 * and every workspace's own dir (data/workspaces/<id>/graph/, decision 8).
 * Every read/write in the adapter goes through `files` and NOTHING else: an
 * instance can never straddle two directories. The format stamp
 * (graph-format.ts) is per-directory too.
 *
 * Implements core/ports.ts GraphStore. Each graph dir is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	GRAPH_FORMAT_FILE,
	LEDGER_FILES,
	POSITIONS_FILE,
	RENDER_SETTINGS_FILE,
	SOURCES_FILE,
	type GraphFiles,
} from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

/** The legacy global graph dir's file family (decision 9): data/graph/,
 *  byte-identical to the module constants this adapter used pre-Phase-4. */
export const LEGACY_GRAPH_FILES: GraphFiles = {
	nodes: LEDGER_FILES.nodes,
	chains: LEDGER_FILES.chains,
	sessions: LEDGER_FILES.sessions,
	coverage: LEDGER_FILES.coverage,
	positions: POSITIONS_FILE,
	sources: SOURCES_FILE,
	renderSettings: RENDER_SETTINGS_FILE,
	format: GRAPH_FORMAT_FILE,
};

// ─── JSONL primitives ────────────────────────────────────────────────────────

/** The stamp host of one graph family: every primitive carries its own
 *  GraphFiles (per-directory seam, Phase 4). */

function appendLine(files: GraphFiles, file: string, record: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(files); // the lazy format stamp (graph-format.ts)
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(files: GraphFiles, file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(files); // honest refusal on a newer-stamped data dir
	return readRawLines(file).filter(isValid);
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

// ─── the port implementation ────────────────────────────────────────────────

/** THE FACTORY (workspace wave Phase 4): one store instance bound to ONE
 *  graph directory (GraphFiles). The legacy export `graphStore` =
 *  createGraphStore(LEGACY_GRAPH_FILES) — byte-identical behavior to the
 *  pre-Phase-4 module constant (the golden fixtures pin it); every other
 *  graph dir (a workspace's data/workspaces/<id>/graph/) gets its own
 *  instance from src/server/stores.ts's graphStoreFor. */
export function createGraphStore(files: GraphFiles): GraphStore {
	// One purge per directory at factory time: dead ledgers are exactly the
	// confusion the cleanup removes (owner doctrine — nothing reads them,
	// nothing writes them, a stale file lying around is a lie).
	purgeLegacyLedgers(path.dirname(files.nodes));
	return {
	appendNode(node: GraphNode): void {
		appendLine(files, files.nodes, node);
	},
	/** Raw node lines in append order. A node id may appear on more than
	 *  one line (a later session's LINK-append: phrasings + provenance); the
	 *  derivation (core/graph.ts getGraph) merges lines by id. */
	readNodes(): GraphNode[] {
		return readValid(files, files.nodes, isGraphNode);
	},

	/** Append one chain ASSERTION; readers merge lines by (premises,
	 *  conclusion). */
	appendChain(assertion: GraphChain): void {
		appendLine(files, files.chains, assertion);
	},
	readChains(): GraphChain[] {
		return readValid(files, files.chains, isGraphChain);
	},

	appendCheckpoint(checkpoint: SessionCheckpoint): void {
		appendLine(files, files.sessions, checkpoint);
	},
	readCheckpoints(): SessionCheckpoint[] {
		return readValid(files, files.sessions, isCheckpoint);
	},

	appendCoverage(entry: CoverageEntry): void {
		appendLine(files, files.coverage, entry);
	},
	readCoverage(): CoverageEntry[] {
		return readValid(files, files.coverage, isCoverageEntry);
	},

	// ── imported-notes bookkeeping (files.sources — a JSON map) ──

	/** Upsert: keeps the existing record's usage log when re-importing. */
	upsertSource(source: NotesSource): void {
		const all = readSourceMap(files);
		const prev = all[source.id];
		all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
		writeSourceMap(files, all);
	},
	readSources(): NotesSource[] {
		return Object.values(readSourceMap(files));
	},
	/** Idempotent per startedAt — same discipline as chats.appendExtractionUsage. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
		const all = readSourceMap(files);
		const source = all[id];
		if (!source) return; // no such source — nothing to bill against
		source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
			? source.extractions
			: [...(source.extractions ?? []), entry];
		writeSourceMap(files, all);
	},

	// ── the layout ledger (files.positions — a JSON map) ──
	readPositions(): Record<string, Position> {
		return readPositionMap(files);
	},
	writePositions(positions: Record<string, Position>): void {
		writePositionMap(files, positions);
	},

	/** THE DESTRUCTIVE SEAM (wave 6 session deletion): atomic full-content
	 *  replacement per provided ledger — write a uniquely-named temp file
	 *  beside the ledger, then rename over it (POSIX-atomic: a crash mid-
	 *  write leaves the original ledger and an orphan .tmp-*, never a torn
	 *  ledger). Empty arrays write an empty file — a purged ledger reads
	 *  as "nothing yet", same as never-emitted. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void {
		const ledgerFiles = {
			nodes: files.nodes,
			chains: files.chains,
			coverage: files.coverage,
			checkpoints: files.sessions,
		} as const;
		for (const [key, records] of Object.entries(next) as [keyof typeof ledgerFiles, unknown[]][]) {
			const file = ledgerFiles[key];
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				// JSONL: one record per line, trailing newline — a reader
				// must see exactly what appendLine would have written.
				const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
				fs.writeFileSync(tmp, body, "utf-8");
				fs.renameSync(tmp, file);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* the rename either already happened or the tmp never existed */
				}
				throw err;
			}
		}
	},
	};
}



/** The legacy global graph store (decision 9): data/graph/, byte-identical
 *  to the pre-Phase-4 module export. Read-only for new sessions (Unsorted
 *  sessions write nothing — docs/workspaces.md); the graph view's
 *  "Global (legacy)" selector and old-provenance reads ride it. */
export const graphStore: GraphStore = createGraphStore(LEGACY_GRAPH_FILES);

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(files: GraphFiles): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(files.positions, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(files: GraphFiles, positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(files.positions), { recursive: true });
	// Tmp + rename — the same crash-safety rewriteLedgers uses two blocks
	// up (a9339b3 UI flag): a torn write must never replace the ledger
	// with a half-written file the reader parses as empty.
	const tmp = `${files.positions}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"), "utf-8");
		fs.renameSync(tmp, files.positions);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(files: GraphFiles): Record<string, NotesSource> {
	assertGraphFormat(files); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(files.sources, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeSourceMap(files: GraphFiles, map: Record<string, NotesSource>): void {
	fs.mkdirSync(path.dirname(files.sources), { recursive: true });
	ensureGraphFormat(files); // the lazy format stamp (graph-format.ts)
	fs.writeFileSync(files.sources, JSON.stringify(map, null, "\t"), "utf-8");
}

// ─── one-way purges per graph directory at factory creation: dead ledgers
// are exactly the confusion the cleanup removes (owner doctrine — nothing
// reads them, nothing writes them, a stale file lying around is a lie). ─────
function purgeLegacyLedgers(graphDir: string): void {
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
