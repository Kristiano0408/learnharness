/**
 * THE WORKSPACE GRAPH (workspace wave Phase 4, docs/workspaces.md decision 1B):
 * per-workspace graph stores — two isolated ledgers; the extraction pipeline
 * resolves each session's store from its record's workspaceId (fresh read); an
 * Unsorted session rides the composition root's refusing no-op (decision 9):
 * honest refusal, ledger untouched. The legacy global graph stays where it was
 * (read-only for new sessions).
 *
 * Runs under an isolated LH_DATA_DIR (the birth-stamp discipline: the seam is
 * set before any config-loading import, so every app-module import is dynamic);
 * faux engines drive the pipeline (the extraction.test idiom).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-graph-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { graphStoresForChat, purgeWorkspaceGraphStore } = await import("../src/server/stores.ts");
const { stores } = await import("../src/server/stores.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { workspaceStore } = await import("../src/store/workspaces.ts");
const { graphView, graphRevision } = await import("../src/server/graph.ts");
const { PATHS, workspaceGraphDir } = await import("../config.ts");
const { WORKSPACE_GRAPH_REFUSAL } = await import("../src/core/workspace-refusal.ts");
const { graphSnapshot } = await import("../src/core/graph.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;

const createdChats: string[] = [];
const createdWorkspaces: string[] = [];

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdWorkspaces) workspaceStore.deleteWorkspace(id);
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** An engine whose ONE response is the `name` tool call with the given input. */
function submitModel(name: string, input: unknown): PiEngine {
	return fauxEngine([
		(context) => {
			void context;
			return fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], {
				stopReason: "toolUse",
			});
		},
	]);
}

function user(id: string, text: string) {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function assistant(id: string, texts: string[]) {
	return [
		{
			id,
			role: "assistant",
			content: texts.map((text) => ({ type: "text", text })),
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	];
}

/** What the extractor SUBMITS for a fixture session — one proposition, no
 *  chains (the isolation test only needs node lines). */
const FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Wave mechanics",
			statement: "Waves transfer energy through a medium without transporting matter.",
			aliases: [],
			messageId: "a1",
		},
	],
	chains: [],
};

function fixtureChat(workspaceId?: string) {
	const chat = chatStore.createChat("Workspace graph fixture", undefined, workspaceId);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me waves"),
		...assistant("a1", ["Waves transfer energy through a medium without transporting matter."]),
	]);
	return { chatId: chat.id };
}

function mkWorkspace(name: string) {
	const ws = workspaceStore.createWorkspace(name);
	createdWorkspaces.push(ws.id);
	return ws;
}

/** A fresh pipeline wired through the REAL composition-root resolver — every
 *  run resolves its store from the session record (the Phase 4 seam). */
function resolvedPipeline() {
	return createExtractionPipeline({
		chatStore,
		graphStore: stores.graphStore, // the legacy default fallback (never used when the seam is present)
		resolveGraphStoreForChat: (chatId) => graphStoresForChat.forChat(chatId),
		extractor: submitModel("submit_findings", FINDINGS),
		auditor: submitModel("submit_review", { links: [] }),
	});
}

// ─── the tests ───────────────────────────────────────────────────────────────

it("workspace graphs are isolated ledger families: A's merge never reaches B", async () => {
	const wsA = mkWorkspace("Linear Algebra");
	const wsB = mkWorkspace("Music");

	const inA = fixtureChat(wsA.id);
	// Pre-filing the session into B would make B a second read… impossible via
	// move; here: run A's extraction, then read B untouched.
	const statsA = await resolvedPipeline().runExtraction(inA.chatId);
	assert.equal(statsA.nodes, 1, "A merged one proposition");

	const nodesA = stores.graphStore.readNodes(); // legacy untouched
	assert.equal(nodesA.some((n) => n.name === "Wave mechanics"), false, "legacy graph stays empty");

	const graphA = graphStoresForChat.forWorkspace(wsA.id).readNodes();
	assert.equal(graphA.filter((n) => n.name === "Wave mechanics").length, 1);

	// B — fresh store instance, its own directory, reads empty.
	const graphB = graphStoresForChat.forWorkspace(wsB.id);
	assert.deepEqual(graphB.readNodes(), []);
	assert.deepEqual(graphB.readCoverage(), []);

	// Directories: every workspace's ledgers live INSIDE its folder (decision 8).
	const dirA = workspaceGraphDir(wsA.id);
	const dirB = workspaceGraphDir(wsB.id);
	assert.ok(dirA.includes(wsA.id) && dirB.includes(wsB.id));
	assert.ok(fs.existsSync(path.join(dirA, "nodes.jsonl")), "A's ledger landed in A's folder");
	assert.ok(!fs.existsSync(path.join(dirB, "nodes.jsonl")), "B has nothing yet");

	// The snapshot selector (decision C1): the route-shaped reads agree.
	const viewA = graphView(wsA.id);
	const viewB = graphView(wsB.id);
	assert.equal(viewA.nodes.filter((n) => n.name === "Wave mechanics").length, 1);
	assert.equal(viewB.nodes.length, 0);

	// Per-workspace version stamps (Phase 6 selector).
	assert.ok(graphRevision(wsA.id) > 0, "A's stamp moved with its merge");
	assert.equal(graphRevision(wsB.id), 0, "B has nothing yet — honest zero");
});

it("an Unsorted session rides the refusing no-op (decision 9): honest refusal, ledgers untouched", async () => {
	const unsorted = fixtureChat(); // workspaceId absent
	const stats = await resolvedPipeline().runExtraction(unsorted.chatId);

	// The refused run ends as an abort (AbortError name) — nothing merged…
	assert.deepEqual(stats, { nodes: 0, chains: 0 }, "nothing merged");
	// …no ledger written ANYWHERE: not the legacy global graph, not a workspace.
	assert.equal(stores.graphStore.readNodes().some((n) => n.name === "Wave mechanics"), false);
	assert.equal(stores.graphStore.readCoverage().some((row) => row.chatId === unsorted.chatId), false);
	// …the refusal spent NOTHING: the usage log records the failed attempt with
	// no model ever called (the abort path's partial-usage doctrine — the
	// extractor stage never ran).
	const record = chatStore.getChat(unsorted.chatId)!;
	if (record.extractions?.length) {
		const run = record.extractions[0]! as unknown as { stats?: unknown; stages?: { extractor?: { model?: string; steps?: unknown[] } } };
		assert.equal(run.stats, undefined, "nothing merged");
		assert.equal(run.stages?.extractor?.model, "unknown", "no model ever called");
		assert.equal(run.stages?.extractor?.steps?.length ?? 0, 0, "zero extractor steps");
	}

	// The refusal rides through the resolver: honest text, write gated.
	const resolved = graphStoresForChat.forChat(unsorted.chatId);
	assert.notEqual(resolved, null);
	assert.equal(resolved!.refused, true, "the structural stamp");
	assert.throws(() => resolved!.appendCoverage({ chatId: unsorted.chatId, fp: "x", tokens: 1, foldedAt: "2026-10-28T00:00:00.000Z" }), (err: Error) =>
		err.message.includes(WORKSPACE_GRAPH_REFUSAL),
	);
	// Reads stay empty — honest "nothing yet".
	assert.deepEqual(resolved!.readNodes(), []);
});

it("the legacy global graph stays byte-identical beside the workspace stores", async () => {
	// Pre-Phase-4 data: a node line written through the legacy store.
	stores.graphStore.appendNode({
		id: "n_legacy_probe",
		name: "Legacy probe",
		statement: "A proposition from before the workspace wave.",
		aliases: [],
		createdAt: "2026-10-28T00:00:00.000Z",
		provenance: [{ chatId: "chat_legacy_probe", messageId: "" }],
	});
	const legacyBefore = stores.graphStore.readNodes();

	const ws = mkWorkspace("Fresh workspace");
	const stats = await resolvedPipeline().runExtraction(fixtureChat(ws.id).chatId);
	assert.equal(stats.nodes, 1);

	assert.deepEqual(stores.graphStore.readNodes(), legacyBefore, "the legacy ledgers rode untouched");
	// A workspace extraction never touches the legacy global graph.
	const snapshotLegacy = graphSnapshot({ chatStore, graphStore: stores.graphStore });
	assert.ok(snapshotLegacy.nodes.some((n) => n.id === "n_legacy_probe"), "old data still reads");
});

it("the resolver map is cached per workspace and purged on deletion", () => {
	const ws = mkWorkspace("Cache probe");
	const first = graphStoresForChat.forWorkspace(ws.id);
	const second = graphStoresForChat.forWorkspace(ws.id);
	assert.equal(first, second, "one instance per workspace id (the Map cache)");
	const graphDir = workspaceGraphDir(ws.id);
	first.appendNode({
		id: "n_cache_probe",
		name: "Cache probe",
		statement: "Cache probe statement",
		aliases: [],
		createdAt: "2026-10-28T00:00:00.000Z",
		provenance: [{ chatId: "chat_cache_probe", messageId: "" }],
	});
	assert.ok(fs.existsSync(path.join(graphDir, "nodes.jsonl")), "the store writes ride its directory");
	purgeWorkspaceGraphStore(ws.id);
	const afterPurge = graphStoresForChat.forWorkspace(ws.id);
	assert.notEqual(afterPurge, first, "the purge seam drops the instance — a fresh store re-binds the directory");
	assert.equal(afterPurge.readNodes().some((n) => n.id === "n_cache_probe"), true, "the ledger on disk rides on (purging a store does not erase its data)");
});
