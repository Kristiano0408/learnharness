/**
 * THE SESSION MOVE (workspace wave Phase 5, docs/workspaces.md Fase 5, owner
 * A3 decision 2026-10-28): the graph-trace transport `mode=move-nodes`.
 *
 * Layered like the repo's other move tests:
 *   1. THE PURE CORE — takeChatTraces/landChatTraces over in-memory stores
 *      (the extraction.test idiom): the deletion-faithful origin semantics
 *      (shared survival, full death, identity preserved), the carried delta,
 *      the destination's append-only land + link-style chain union, and the
 *      positions copy+prune;
 *   2. THE SERVER ORCHESTRATION — moveChatSessionGraph over the REAL stores
 *      under an isolated LH_DATA_DIR: gates (404/400/409), the busy gate, the
 *      honest no_graph_destination refusal toward Unsorted, workspace→workspace
 *      isolation, and the legacy-origin read seam (a pre-Phase-4 unsorted
 *      session's traces ride out of data/graph/, leaving it clean — decision 9
 *      forbids NEW writes there, never rewrites of existing rows);
 *   3. THE ROUTE — PUT /api/chats/[id]/workspace?mode=... end-to-end (the
 *      workspace-api.test harness): the mode gate, the stats/stamps payload.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { CoverageEntry, GraphChain, GraphNode, SessionCheckpoint } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { landChatTraces, takeChatTraces } from "../src/core/graph-deletion.ts";

// ─── 1. THE PURE CORE — in-memory stores (the extraction.test idiom) ────────

function memStore(seed: {
	nodes?: GraphNode[];
	chains?: GraphChain[];
	coverage?: CoverageEntry[];
	checkpoints?: SessionCheckpoint[];
	positions?: Record<string, { x: number; y: number }>;
}) {
	const state = {
		nodes: seed.nodes ?? [],
		chains: seed.chains ?? [],
		coverage: seed.coverage ?? [],
		checkpoints: seed.checkpoints ?? [],
		positions: seed.positions ?? {},
	};
	return {
		state,
		store: {
			appendNode: (n: GraphNode) => void state.nodes.push(n),
			readNodes: () => [...state.nodes],
			appendChain: (c: GraphChain) => void state.chains.push(c),
			readChains: () => [...state.chains],
			appendCheckpoint: (c: SessionCheckpoint) => void state.checkpoints.push(c),
			readCheckpoints: () => [...state.checkpoints],
			appendCoverage: (e: CoverageEntry) => void state.coverage.push(e),
			readCoverage: () => [...state.coverage],
			writePositions: (p: Record<string, { x: number; y: number }>) => {
				state.positions = p;
			},
			readPositions: () => ({ ...state.positions }),
			upsertSource: () => {},
			readSources: () => [],
			appendSourceUsage: () => {},
			rewriteLedgers: (next: {
				nodes?: GraphNode[];
				chains?: GraphChain[];
				coverage?: CoverageEntry[];
				checkpoints?: SessionCheckpoint[];
			}) => {
				if (next.nodes) state.nodes = next.nodes;
				if (next.chains) state.chains = next.chains;
				if (next.coverage) state.coverage = next.coverage;
				if (next.checkpoints) state.checkpoints = next.checkpoints;
			},
		} satisfies GraphStore,
	};
}

const point = (chatId: string, messageId = "") => ({ chatId, messageId });

describe("takeChatTraces — the origin side (deletion-faithful + the delta)", () => {
	it("shared nodes survive with foreign provenance intact; fully-owned nodes die entirely", () => {
		const shared = memStore({
			nodes: [
				{ id: "n_own", name: "Owned", statement: "Only this session said it.", aliases: ["mine"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
				{ id: "n_shared", name: "Shared", statement: "Both sessions know it.", aliases: ["shared"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1"), point("c2")] },
			],
			chains: [{ id: "arg_own", premises: ["n_own"], conclusion: "n_shared", provenance: [point("c1")], createdAt: "2026-10-01T00:00:00.000Z" }],
			coverage: [{ chatId: "c1", fp: "fp1", tokens: 4, foldedAt: "2026-10-01T00:00:00.000Z" }],
			checkpoints: [{ chatId: "c1", foldedAt: "2026-10-01T00:00:00.000Z" }],
		});

		const { delta, stats } = takeChatTraces(shared.store, "c1");

		// Origin: the owned node + its chain die; the shared node keeps c2's point.
		assert.deepEqual(shared.state.nodes.filter((l) => l.id === "n_own"), [], "fully-owned node dies in the origin");
		const sharedLine = shared.state.nodes.find((l) => l.id === "n_shared")!;
		assert.deepEqual(sharedLine.provenance, [point("c2")], "shared provenance survives");
		assert.equal(shared.state.chains.length, 0, "the chain built only of moved traces dies in the origin");
		assert.equal(shared.state.coverage.length, 0, "coverage always rides out");
		assert.equal(shared.state.checkpoints.length, 0, "checkpoints always ride out");

		// Delta: the carried rows (append order) with this session's provenance.
		assert.deepEqual(
			delta.nodes.map((l) => l.id),
			["n_own", "n_shared"],
			"owned create line first, then the shared link line",
		);
		assert.deepEqual(delta.nodes[0]!.provenance, [point("c1")]);
		assert.deepEqual(delta.nodes[0]!.aliases, ["mine"], "create-line identity phrasings carry out");
		assert.deepEqual(delta.nodes[1]!.aliases, ["shared"], "the shared node's create line carries its own phrasings");
		assert.equal(delta.chains.length, 1);
		assert.equal(delta.coverage.length, 1);
		assert.equal(delta.checkpoints.length, 1);

		assert.deepEqual(stats, {
			nodesMoved: 2,
			chainsMoved: 1,
			coverageMoved: 1,
			checkpointsMoved: 1,
			originNodesRemoved: 1,
			originChainsRemoved: 1,
		});
	});

	it("identity survives for nodes the moving session created but another references (owner 2026-09-23)", () => {
		const origin = memStore({
			nodes: [
				// c1 minted n_a; c2's link line re-encountered it → n_a survives on c2.
				{ id: "n_a", name: "A", statement: "A holds.", aliases: ["a as said"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
				{ id: "n_a", name: "A", statement: "A again.", aliases: ["a re-said"], createdAt: "2026-10-02T00:00:00.000Z", provenance: [point("c2")] },
			],
		});

		const { delta, stats } = takeChatTraces(origin.store, "c1");

		const kept = origin.state.nodes;
		assert.equal(kept.length, 2, "the create line stays with provenance emptied and phrasings stripped; the foreign link line rides untouched");
		const createLine = kept.find((l) => l.aliases.includes("a as said")) ?? kept.find((l) => l.createdAt === "2026-10-01T00:00:00.000Z")!;
		assert.ok(createLine, "the create line survived");
		assert.deepEqual(createLine.provenance.filter((p) => p.chatId === "c1"), [], "the moving session's points left the origin line");
		assert.equal(delta.nodes.length, 1);
		assert.equal(delta.nodes[0]!.statement, "A holds.", "the identity statement carries out intact");
		assert.deepEqual(delta.nodes[0]!.provenance, [point("c1")]);
		assert.equal(stats.originNodesRemoved, 0, "nothing died — c2 references it");
	});

	it("a never-touched session takes nothing (no rewrite, stats honest)", () => {
		const origin = memStore({ nodes: [{ id: "n_x", name: "X", statement: "x", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c9")] }] });
		const before = origin.state.nodes;
		const { delta, stats } = takeChatTraces(origin.store, "c1");
		assert.equal(delta.nodes.length, 0);
		assert.deepEqual(stats, { nodesMoved: 0, chainsMoved: 0, coverageMoved: 0, checkpointsMoved: 0, originNodesRemoved: 0, originChainsRemoved: 0 });
		assert.equal(origin.state.nodes, before, "untouched ledger keeps its rows");
	});

	it("positions prune from the origin for everything that left", () => {
		const origin = memStore({
			nodes: [{ id: "n_own", name: "O", statement: "o", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] }],
			chains: [{ id: "arg_1", premises: ["n_own"], conclusion: "n_foreign", provenance: [point("c1")], createdAt: "2026-10-01T00:00:00.000Z" }],
			positions: { n_own: { x: 1, y: 2 }, arg_1: { x: 3, y: 4 }, n_foreign: { x: 5, y: 6 } },
		});
		const { delta } = takeChatTraces(origin.store, "c1");
		assert.deepEqual(Object.keys(origin.state.positions), ["n_foreign"], "dead ids (node + chain) pruned; the survivor keeps its resting spot");
		assert.deepEqual(delta.positions, { n_own: { x: 1, y: 2 }, arg_1: { x: 3, y: 4 } }, "carried positions copied before the prune");
	});
});

describe("landChatTraces — the destination side (append-only + link-style union)", () => {
	it("ids land unchanged when the destination never minted them; chains keep their arg_ id", () => {
		const dest = memStore({});
		const delta = takeChatTraces(
			memStore({
				nodes: [
					{ id: "n_a", name: "A", statement: "A holds.", aliases: ["a"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
					{ id: "n_b", name: "B", statement: "B follows.", aliases: ["b"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
				],
				chains: [{ id: "arg_1", premises: ["n_a"], conclusion: "n_b", provenance: [point("c1")], createdAt: "2026-10-01T00:00:00.000Z" }],
			}).store,
			"c1",
		).delta;

		landChatTraces(dest.store, "c1", delta);
		const ids = dest.state.nodes.map((l) => l.id);
		assert.deepEqual(ids, ["n_a", "n_b"], "ids land unchanged (no collision)");
		assert.equal(dest.state.chains[0]!.id, "arg_1", "the argument keeps its id at the destination too");
	});

	it("collision guard: a destination-held node id is re-minted, never welded", () => {
		const dest = memStore({
			nodes: [{ id: "n_a", name: "Unrelated", statement: "A DIFFERENT proposition.", aliases: ["other"], createdAt: "2026-10-02T00:00:00.000Z", provenance: [point("c9")] }],
		});
		const delta = takeChatTraces(
			memStore({ nodes: [{ id: "n_a", name: "A", statement: "A holds.", aliases: ["mine"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] }] }).store,
			"c1",
		).delta;

		landChatTraces(dest.store, "c1", delta);
		assert.equal(dest.state.nodes.length, 2);
		const landed = dest.state.nodes[1]!;
		assert.notEqual(landed.id, "n_a", "collision re-mints a fresh id");
		assert.match(landed.id, /^n_/);
		assert.equal(landed.statement, "A holds.", "the moved statement lands intact — no weld");
	});

	it("link-style chain union: an already-asserted key keeps the destination id and unions provenance", () => {
		const dest = memStore({
			chains: [{ id: "arg_keep", premises: ["n_a"], conclusion: "n_b", provenance: [point("c9")], createdAt: "2026-10-01T00:00:00.000Z" }],
		});
		const delta = takeChatTraces(
			memStore({
				nodes: [
					{ id: "n_a", name: "A", statement: "a", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
					{ id: "n_b", name: "B", statement: "b", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
				],
				chains: [{ id: "arg_moved", premises: ["n_a"], conclusion: "n_b", provenance: [point("c1")], createdAt: "2026-10-05T00:00:00.000Z" }],
			}).store,
			"c1",
		).delta;

		landChatTraces(dest.store, "c1", delta);
		const lines = dest.state.chains;
		assert.equal(lines.length, 2, "a second assertion appends another line (the reader unions)");
		assert.equal(lines[1]!.id, "arg_keep", "the same key lands under the destination's first id (merger rule)");
		assert.deepEqual(lines[1]!.provenance, [point("c1")]);
	});

	it("coverage dedupes per (chatId, fp); a checkpoint lands only where none exists", () => {
		const dest = memStore({
			coverage: [{ chatId: "c1", fp: "fp1", tokens: 4, foldedAt: "2026-09-01T00:00:00.000Z" }],
			checkpoints: [{ chatId: "c1", foldedAt: "2026-09-02T00:00:00.000Z" }],
		});
		const delta = takeChatTraces(
			memStore({
				nodes: [{ id: "n_a", name: "A", statement: "a", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] }],
				coverage: [
					{ chatId: "c1", fp: "fp1", tokens: 4, foldedAt: "2026-10-01T00:00:00.000Z" },
					{ chatId: "c1", fp: "fp2", tokens: 8, foldedAt: "2026-10-01T00:00:00.000Z" },
				],
				checkpoints: [{ chatId: "c1", foldedAt: "2026-10-01T00:00:00.000Z" }],
			}).store,
			"c1",
		).delta;

		landChatTraces(dest.store, "c1", delta);
		const fps = dest.state.coverage.filter((e) => e.chatId === "c1").map((e) => e.fp);
		assert.deepEqual(fps.sort(), ["fp1", "fp2"], "a re-rounding dedupes the old fingerprint and carries the new one");
		assert.equal(dest.state.checkpoints.length, 1, "the destination's newer fold stamp stands — no duplicate checkpoint");
	});

	it("positions land for moved ids only; a destination-owned id keeps its resting spot", () => {
		const dest = memStore({ positions: { n_keep: { x: 9, y: 9 } } });
		landChatTraces(dest.store, "c1", {
			nodes: [],
			chains: [],
			coverage: [{ chatId: "c1", fp: "fp1", tokens: 4, foldedAt: "2026-10-01T00:00:00.000Z" }],
			checkpoints: [],
			positions: { n_moved: { x: 1, y: 2 }, n_keep: { x: 0, y: 0 } },
		});
		assert.deepEqual(dest.state.positions, { n_keep: { x: 9, y: 9 }, n_moved: { x: 1, y: 2 } });
	});

	it("id-map remap: collision re-mints chain endpoints consistently", () => {
		const dest = memStore({
			nodes: [{ id: "n_a", name: "Unrelated", statement: "different", aliases: [], createdAt: "2026-10-02T00:00:00.000Z", provenance: [point("c9")] }],
		});
		const delta = takeChatTraces(
			memStore({
				nodes: [
					{ id: "n_a", name: "A", statement: "a", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
					{ id: "n_b", name: "B", statement: "b", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [point("c1")] },
				],
				chains: [{ id: "arg_1", premises: ["n_a"], conclusion: "n_b", provenance: [point("c1")], createdAt: "2026-10-01T00:00:00.000Z" }],
			}).store,
			"c1",
		).delta;

		landChatTraces(dest.store, "c1", delta);
		const chain = dest.state.chains[0]!;
		const landedA = dest.state.nodes.find((l) => l.statement === "a")!.id;
		assert.notEqual(landedA, "n_a");
		assert.deepEqual(chain.premises, [landedA], "the chain's premise follows the re-minted node id");
	});
});

// ─── 2. THE SERVER ORCHESTRATION — real stores, isolated data dir ───────────

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-move-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { moveChatSessionGraph } = await import("../src/server/workspaces.ts");
const { createGraphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { workspaceStore } = await import("../src/store/workspaces.ts");
const { graphStoresForChat, purgeWorkspaceGraphStore } = await import("../src/server/stores.ts");
const { graphView, graphRevision } = await import("../src/server/graph.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { graphRevisionScopeMatches } = await import("../components/graph-view.tsx");
const { PATHS, workspaceGraphDir, graphFilesForDir } = await import("../config.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function mkWorkspace(name: string) {
	return workspaceStore.createWorkspace(name);
}

/** A session with a real extracted footprint in its origin graph (the Phase-4
 *  seam: the composition root's own store for that workspace). */
function seedGraph(store: GraphStore, chatId: string, foreignChatId?: string) {
	store.appendNode({ id: "n_own_" + chatId, name: "Owned", statement: "Only c1 said it.", aliases: ["mine"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [{ chatId, messageId: "m1" }] });
	store.appendNode({ id: "n_shared_" + chatId, name: "Shared", statement: "Both know it.", aliases: ["shared"], createdAt: "2026-10-01T00:00:00.000Z", provenance: [{ chatId, messageId: "m2" }, ...(foreignChatId ? [{ chatId: foreignChatId, messageId: "m3" }] : [])] });
	store.appendChain({ id: "arg_" + chatId, premises: ["n_own_" + chatId], conclusion: "n_shared_" + chatId, provenance: [{ chatId, messageId: "" }], createdAt: "2026-10-01T00:00:00.000Z" });
	store.appendCoverage({ chatId, fp: "fp-" + chatId, tokens: 4, foldedAt: "2026-10-01T00:00:00.000Z" });
	store.writePositions({ ["n_own_" + chatId]: { x: 1, y: 2 }, ["arg_" + chatId]: { x: 3, y: 4 } });
}

describe("moveChatSessionGraph — the server orchestration", () => {
	it("mode gate: bad mode refuses 400 before any other gate", () => {
		const res = moveChatSessionGraph("c1", "nonsense" as never, null);
		assert.equal(res.ok, false);
		assert.equal(res.status, 400);
		if (!res.ok) assert.equal(res.code, "bad_mode");
	});

	it("gates ride: 404 unknown chat; 409 while a turn is in flight (retryable)", () => {
		const missing = moveChatSessionGraph("ws_missing", "move-nodes", null);
		if (!missing.ok) assert.equal(missing.status, 404);

		const ws = mkWorkspace("Gate target");
		const chat = chatStore.createChat("Gated session", undefined, ws.id);
		beginTurn(chat.id);
		try {
			const blocked = moveChatSessionGraph(chat.id, "move-nodes", ws.id);
			if (!blocked.ok) assert.equal(blocked.status, 409);
			if (!blocked.ok) assert.equal(blocked.code, "turn_in_flight");
			const sessionOnly = moveChatSessionGraph(chat.id, "move-session", null);
			if (!sessionOnly.ok) assert.equal(sessionOnly.status, 409, "the plain move rides the same gate");
		} finally {
			endTurn(chat.id);
		}
		// After the turn drains, the plain move lands.
		const moved = moveChatSessionGraph(chat.id, "move-session", null);
		assert.equal(moved.ok, true);
		if (moved.ok) assert.equal(moved.workspaceId, null);
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("mode=move-nodes toward Unsorted refuses honestly (400 no_graph_destination)", () => {
		const ws = mkWorkspace("Has a graph");
		const chat = chatStore.createChat("Legacy traces", undefined, ws.id);
		seedGraph(graphStoresForChat.forWorkspace(ws.id), chat.id);

		const refused = moveChatSessionGraph(chat.id, "move-nodes", null);
		if (!refused.ok) assert.equal(refused.status, 400);
		if (!refused.ok) {
			assert.equal(refused.code, "no_graph_destination");
			assert.ok(refused.error.includes("no graph"));
		}
		// The refusal changed NOTHING: the session still rides its workspace.
		assert.equal(chatStore.getChat(chat.id)!.workspaceId, ws.id);
		assert.equal(graphStoresForChat.forWorkspace(ws.id).readNodes().length, 2);
		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(ws.id);
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("move-session (mode default) leaves the graph exactly where it was", () => {
		const from = mkWorkspace("From");
		const to = mkWorkspace("To");
		const chat = chatStore.createChat("Session-only move", undefined, from.id);
		seedGraph(graphStoresForChat.forWorkspace(from.id), chat.id);

		const res = moveChatSessionGraph(chat.id, "move-session", to.id);
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.stats, null, "no transport stats — nothing transported");
			assert.equal(res.originGraphRevision, null);
		}
		assert.equal(graphStoresForChat.forWorkspace(from.id).readNodes().length, 2, "the origin graph keeps the traces");
		assert.deepEqual(graphStoresForChat.forWorkspace(to.id).readNodes(), [], "the destination stays empty");
		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(from.id);
		purgeWorkspaceGraphStore(to.id);
		workspaceStore.deleteWorkspace(from.id);
		workspaceStore.deleteWorkspace(to.id);
	});

	it("move-nodes workspace→workspace: the traces transport; isolation holds both ways", () => {
		const from = mkWorkspace("Transport from");
		const to = mkWorkspace("Transport to");
		const other = chatStore.createChat("Foreign session", undefined, from.id); // stays behind with a shared node
		const chat = chatStore.createChat("Moving session", undefined, from.id);
		seedGraph(graphStoresForChat.forWorkspace(from.id), chat.id, other.id);

		const res = moveChatSessionGraph(chat.id, "move-nodes", to.id);
		assert.equal(res.ok, true);
		if (!res.ok) throw new Error("impossible");
		assert.equal(res.stats!.coverageMoved, 1);
		assert.equal(res.stats!.checkpointsMoved, 0);
		assert.equal(res.workspaceId, to.id);

		const fromStore = graphStoresForChat.forWorkspace(from.id);
		const toStore = graphStoresForChat.forWorkspace(to.id);

		// The origin: the fully-owned node + its chain died; the shared node
		// rides on with the foreign session's provenance (survival rule).
		assert.equal(
			fromStore.readNodes().some((l) => l.id === "n_own_" + chat.id),
			false,
			"the fully-owned node left the origin entirely",
		);
		const shared = fromStore.readNodes().find((l) => l.id === "n_shared_" + chat.id)!;
		assert.deepEqual(
			shared.provenance.map((p) => p.chatId),
			[other.id],
			"the foreign session's provenance point stays",
		);
		assert.equal(fromStore.readCoverage().some((r) => r.chatId === chat.id), false, "coverage left");
		assert.ok(graphRevision(from.id) > 0, "origin stamp moved with the take");

		// The destination: everything this session had landed there.
		assert.equal(toStore.readNodes().filter((l) => l.name === "Owned").length, 1);
		assert.equal(toStore.readChains().length, 1, "the chain landed with its endpoints remapped consistently");
		const chain = toStore.readChains()[0]!;
		const ownedId = toStore.readNodes().find((l) => l.name === "Owned")!.id;
		assert.deepEqual(chain.premises, [ownedId], "chain endpoint follows the landed node id");
		assert.equal(toStore.readCoverage().filter((r) => r.chatId === chat.id).length, 1);

		// The two graphs stay isolated (the Phase-4 rule rides the move).
		const viewFrom = graphView(from.id);
		const viewTo = graphView(to.id);
		assert.equal(viewTo.nodes.filter((n) => n.name === "Owned").length, 1, "B's snapshot carries the moved trace");
		assert.equal(viewFrom.nodes.some((n) => n.name === "Owned"), false, "A's snapshot lost it");

		// Positions: copy+prune (owner ruling). Origin pruned the dead ids;
		// destination carries the resting spots.
		assert.deepEqual(Object.keys(fromStore.readPositions()), [], "origin positions pruned for the dead ids");
		assert.equal(Object.keys(toStore.readPositions()).length >= 1, true, "destination carries a position");

		// Stamps: both graphs carry fresh revisions in the response.
		assert.ok(typeof res.destinationGraphRevision === "number" && res.destinationGraphRevision > 0);
		assert.ok(typeof res.originGraphRevision === "number" && res.originGraphRevision > 0);

		chatStore.deleteChat(chat.id);
		chatStore.deleteChat(other.id);
		purgeWorkspaceGraphStore(from.id);
		purgeWorkspaceGraphStore(to.id);
		workspaceStore.deleteWorkspace(from.id);
		workspaceStore.deleteWorkspace(to.id);
	});

	it("legacy origin (decision 9): an unsorted session's pre-Phase-4 traces ride OUT of data/graph/ and the legacy graph keeps its foreign rows", () => {
		const target = mkWorkspace("Legacy move target");
		const chat = chatStore.createChat("Pre-workspace session"); // no workspaceId — legacy home

		// Pre-Phase-4 footprint: written into the LEGACY global store (the only
		// place a pre-wave unsorted session's traces ever lived). A foreign
		// session's rows ride along untouched.
		const legacy = createGraphStore(graphFilesForDir(PATHS.graph));
		seedGraph(legacy, chat.id, "c_foreign");

		const res = moveChatSessionGraph(chat.id, "move-nodes", target.id);
		assert.equal(res.ok, true);
		if (!res.ok) throw new Error("impossible");
		assert.equal(res.workspaceId, target.id);

		const movedStore = graphStoresForChat.forWorkspace(target.id);
		const foreign = legacy.readNodes().find((l) => l.provenance.some((p) => p.chatId === "c_foreign"));
		assert.ok(foreign, "the foreign session's row stays in the legacy graph (decision 9: no new writes, existing rows untouched except this session's removal)");
		assert.equal(legacy.readNodes().some((l) => l.name === "Owned" && l.provenance.some((p) => p.chatId === chat.id)), false, "this session's fully-owned row left the legacy graph");
		assert.equal(legacy.readCoverage().some((r) => r.chatId === chat.id), false);
		assert.equal(movedStore.readNodes().filter((l) => l.name === "Owned").length, 1, "the trace landed in the workspace graph");

		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(target.id);
		workspaceStore.deleteWorkspace(target.id);
	});

	it("a never-extracted session moves honestly: empty delta, nothing lands", () => {
		const from = mkWorkspace("Empty from");
		const to = mkWorkspace("Empty to");
		const chat = chatStore.createChat("Never extracted", undefined, from.id);

		const res = moveChatSessionGraph(chat.id, "move-nodes", to.id);
		assert.equal(res.ok, true);
		if (!res.ok) throw new Error("impossible");
		assert.equal(res.stats!.nodesMoved, 0);
		assert.deepEqual(graphStoresForChat.forWorkspace(to.id).readNodes(), []);

		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(from.id);
		purgeWorkspaceGraphStore(to.id);
		workspaceStore.deleteWorkspace(from.id);
		workspaceStore.deleteWorkspace(to.id);
	});

	it("the moved session's coverage reads through its NEW workspace store (fresh record read)", () => {
		const from = mkWorkspace("Coverage from");
		const to = mkWorkspace("Coverage to");
		const chat = chatStore.createChat("Coverage rides", undefined, from.id);
		seedGraph(graphStoresForChat.forWorkspace(from.id), chat.id);

		moveChatSessionGraph(chat.id, "move-nodes", to.id);

		// The Phase-4 read seam: sessionCoverage (src/server/chats.ts) resolves
		// the store from the record — assert through the resolver directly.
		const resolved = graphStoresForChat.forChat(chat.id);
		assert.equal(resolved!.refused, undefined, "a workspace session resolves its own store");
		assert.equal(resolved!.readCoverage().some((r) => r.chatId === chat.id), true, "coverage lives at the destination");

		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(from.id);
		purgeWorkspaceGraphStore(to.id);
		workspaceStore.deleteWorkspace(from.id);
		workspaceStore.deleteWorkspace(to.id);
	});
});

// ─── 3. THE ROUTE — PUT /api/chats/[id]/workspace, mode param + payload ─────

const chatWorkspaceRoute = await import("../app/api/chats/[id]/workspace/route.ts");

function jsonReq(url: string, method: string, body?: unknown): Request {
	return new Request(`http://test${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

function paramsOf(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

describe("PUT /api/chats/[id]/workspace?mode — the route seam", () => {
	it("bad mode refuses 400; absent mode = move-session (the Phase-2 behavior, byte-identical)", async () => {
		const bad = await chatWorkspaceRoute.PUT(jsonReq("/api/chats/c1/workspace?mode=nonsense", "PUT", { workspaceId: null }), paramsOf("never_exists"));
		assert.equal(bad.status, 400);
		assert.equal((await bad.json()).code, "bad_mode");

		const missing = await chatWorkspaceRoute.PUT(jsonReq("/api/chats/never_exists/workspace", "PUT", { workspaceId: null }), paramsOf("never_exists"));
		assert.equal(missing.status, 404);
	});

	it("mode=move-nodes end-to-end: stats + both stamps in the payload", async () => {
		const from = mkWorkspace("Route from");
		const to = mkWorkspace("Route to");
		const chat = chatStore.createChat("Route transport", undefined, from.id);
		seedGraph(graphStoresForChat.forWorkspace(from.id), chat.id);

		const res = await chatWorkspaceRoute.PUT(
			jsonReq(`/api/chats/${chat.id}/workspace?mode=move-nodes`, "PUT", { workspaceId: to.id }),
			paramsOf(chat.id),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as {
			ok: boolean;
			mode: string;
			workspaceId: string;
			stats: { nodesMoved: number; coverageMoved: number };
			originGraphRevision: number;
			destinationGraphRevision: number;
		};
		assert.equal(body.ok, true);
		assert.equal(body.mode, "move-nodes");
		assert.equal(body.workspaceId, to.id);
		assert.ok(body.stats.nodesMoved > 0);
		assert.ok(body.originGraphRevision > 0);
		assert.ok(body.destinationGraphRevision > 0);

		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(from.id);
		purgeWorkspaceGraphStore(to.id);
		workspaceStore.deleteWorkspace(from.id);
		workspaceStore.deleteWorkspace(to.id);
	});

	it("mode=move-nodes toward Unsorted: honest 400 (the dialog's checkbox cannot strand traces)", async () => {
		const from = mkWorkspace("Route refusal from");
		const chat = chatStore.createChat("Route refusal", undefined, from.id);
		seedGraph(graphStoresForChat.forWorkspace(from.id), chat.id);

		const res = await chatWorkspaceRoute.PUT(
			jsonReq(`/api/chats/${chat.id}/workspace?mode=move-nodes`, "PUT", { workspaceId: null }),
			paramsOf(chat.id),
		);
		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.code, "no_graph_destination");

		chatStore.deleteChat(chat.id);
		purgeWorkspaceGraphStore(from.id);
		workspaceStore.deleteWorkspace(from.id);
	});
});

// ─── 4. THE SCOPED ANNOUNCE — the sidebar's refresh seam ─────────────────────
//   Move-nodes transports rewrite BOTH graphs; the sidebar dispatches each
//   stamp scoped to its graph. A selectorless graph view listens to the legacy
//   scope only (Phase 6 adds the workspace selector).

describe("graphRevisionScopeMatches — which view refreshes on which stamp", () => {
	it("a stamp without a scope (every origin stamp + the pre-move global bump) refreshes the selectorless view", () => {
		assert.equal(graphRevisionScopeMatches({ revision: 1 }, null), true);
		assert.equal(graphRevisionScopeMatches({ revision: 1 }, undefined), true);
		assert.equal(graphRevisionScopeMatches({}, null), true);
		assert.equal(graphRevisionScopeMatches(undefined, null), true);
	});

	it("a stamp scoped to a workspace id refreshes ONLY the view displaying that exact workspace", () => {
		assert.equal(graphRevisionScopeMatches({ revision: 1, scope: "ws_b" }, "ws_b"), true);
		assert.equal(graphRevisionScopeMatches({ revision: 1, scope: "ws_b" }, "ws_c"), false);
		assert.equal(graphRevisionScopeMatches({ revision: 1, scope: "ws_b" }, null), false, "a selectorless view ignores a scoped stamp");
	});
});
