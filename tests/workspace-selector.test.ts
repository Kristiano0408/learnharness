/**
 * THE GRAPH-VIEW WORKSPACE SELECTOR (workspace wave Phase 6, docs/workspaces.md
 * Fase 6, decision C1 + owner rulings 2026-10-29): the route band rides the
 * selector — absent = the legacy global graph (byte-identical pre-Phase-6
 * behavior), a workspace id reads that workspace's own ledgers. The pins here
 * cover, in order:
 *   1. THE ROUTE GATES — every scoped graph route (snapshot, costs, positions,
 *      node delete) rejects an unknown workspace honestly (404), accepts the
 *      explicit "global" spelling, and serves the REAL per-workspace isolation
 *      end-to-end (merge in A → visible only from ?workspace=A);
 *   2. THE SCOPED STAMPS — session deletion returns the stamp of the graph it
 *      purged (a workspace session = its workspace's stamp), and the scoped
 *      move stamps name their origin/destination graphs;
 *   3. THE CLIENT SELECTOR SEAM — pure pins: the persisted scope reads honestly,
 *      the option list (Global first, workspaces by store order, Unsorted never
 *      an option), camera memory per scope, and the SSR chrome-row ruling
 *      (the selector renders even on an empty graph). */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ──
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-selector-"));
process.env.LH_DATA_DIR = TMP_DATA;

const graphRoute = await import("../app/api/graph/route.ts");
const costsRoute = await import("../app/api/graph/costs/route.ts");
const positionsRoute = await import("../app/api/graph/positions/route.ts");
const nodeRoute = await import("../app/api/graph/nodes/[id]/route.ts");
const chatIdRoute = await import("../app/api/chats/[id]/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { workspaceStore } = await import("../src/store/workspaces.ts");
const { graphStoresForChat, purgeWorkspaceGraphStore } = await import("../src/server/stores.ts");
const { stores } = await import("../src/server/stores.ts");
const { mergeFindings } = await import("../src/core/graph.ts");
const { PATHS } = await import("../config.ts");

// ─── fixtures ────────────────────────────────────────────────────────────────

const created: string[] = [];

function mkWorkspace(name: string) {
	const ws = workspaceStore.createWorkspace(name);
	created.push(ws.id);
	return ws;
}

/** A minimal merge into a workspace's own store (the Phase 4 factory seam —
 *  the pipeline writes through exactly this store). One proposition per
 *  workspace keeps the isolation pins small. */
function mergeMarker(workspaceId: string, name: string): void {
	const graphStore = graphStoresForChat.forWorkspace(workspaceId);
	const chat = chatStore.createChat(`selector fixture ${name}`, undefined, workspaceId);
	created.push(chat.id);
	mergeFindings(
		chat.id,
		{
			propositions: [
				{
					id: "p1",
					name,
					statement: `The selector fixture proposition for ${name}.`,
					aliases: [],
					messageId: "m1",
				},
			],
			chains: [],
		},
		{ links: [] },
		{ chatStore, graphStore },
		{ foldedAt: chat.updatedAt },
	);
}

after(() => {
	for (const id of created) {
		if (id.startsWith("ws_")) {
			purgeWorkspaceGraphStore(id);
			workspaceStore.deleteWorkspace(id);
		} else {
			chatStore.deleteChat(id);
		}
	}
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function get(url: string): Request {
	return new Request(`http://test${url}`, { method: "GET" });
}
function put(url: string, body?: unknown): Request {
	return new Request(`http://test${url}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}
function params(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

// ─── 1. THE ROUTE GATES + per-workspace isolation ────────────────────────────

describe("graph routes ride the workspace selector (Phase 6, decision C1)", () => {
	it("GET /api/graph: absent = legacy global (today's default), unknown id gates honestly", async () => {
		const legacy = await graphRoute.GET(get("/api/graph"));
		assert.equal(legacy.status, 200);
		const legacyBody = (await legacy.json()) as { nodes: unknown[] };
		assert.ok(Array.isArray(legacyBody.nodes), "the pre-Phase-6 read still serves a snapshot");

		const bad = await graphRoute.GET(get("/api/graph?workspace=.."));
		assert.equal(bad.status, 404, "a path-shape id gates before any store resolves");
		assert.equal((await bad.json()).error, "unknown workspace");

		// A syntactically-valid id no store ever minted reads honestly as an
		// empty graph — never a throw (the refusal-store pattern).
		const ghost = await graphRoute.GET(get("/api/graph?workspace=ws_evergreen"));
		assert.equal(ghost.status, 200);
		assert.deepEqual((await ghost.json()).nodes, [], "honest empty read for an unknown-but-valid id");
	});

	it("GET /api/graph?workspace=<id>: the real per-workspace isolation end-to-end", async () => {
		const wsA = mkWorkspace("Selector A");
		const wsB = mkWorkspace("Selector B");
		mergeMarker(wsA.id, "Linear forms");

		const viewA = (await graphRoute.GET(get(`/api/graph?workspace=${wsA.id}`))).json() as Promise<{
			nodes: { name: string }[];
		}>;
		const bodyA = await viewA;
		assert.equal(bodyA.nodes.filter((n) => n.name === "Linear forms").length, 1);

		const viewB = (await graphRoute.GET(get(`/api/graph?workspace=${wsB.id}`))).json() as Promise<{
			nodes: unknown[];
		}>;
		assert.equal((await viewB).nodes.length, 0, "B's snapshot is honest — A's merge never reaches it");

		const legacy = (await graphRoute.GET(get("/api/graph"))).json() as Promise<{ nodes: { name: string }[] }>;
		assert.equal(
			(await legacy).nodes.filter((n) => n.name === "Linear forms").length,
			0,
			"the legacy global graph never sees a workspace merge (decision 9)",
		);
	});

	it("GET /api/graph/costs: absent + explicit \"global\" = the legacy fold; unknown gates", async () => {
		const ws = mkWorkspace("Selector costs");
		mergeMarker(ws.id, "Fold marker");

		const legacy = await costsRoute.GET(get("/api/graph/costs"));
		assert.equal(legacy.status, 200);
		const globalAlias = await costsRoute.GET(get("/api/graph/costs?workspace=global"));
		assert.equal(globalAlias.status, 200);

		const scoped = (await costsRoute.GET(get(`/api/graph/costs?workspace=${ws.id}`))).json() as Promise<{
			stages: unknown;
			runs: unknown[];
		}>;
		const body = await scoped;
		assert.ok(body.stages !== undefined, "the fold shape rides the selector");
		assert.ok(Array.isArray(body.runs));

		const bad = await costsRoute.GET(get("/api/graph/costs?workspace=.."));
		assert.equal(bad.status, 404);
	});

	it("PUT /api/graph/positions: the ledger family rides the selector; unknown gates", async () => {
		const ws = mkWorkspace("Selector positions");
		mergeMarker(ws.id, "Position marker");
		const node = graphStoresForChat.forWorkspace(ws.id).readNodes().find((n) => n.name === "Position marker")!;

		// A garbage body on a scoped route is still the existing 200/empty rule.
		const empty = await positionsRoute.PUT(put(`/api/graph/positions?workspace=${ws.id}`, {}));
		assert.equal(empty.status, 200);

		const bad = await positionsRoute.PUT(put("/api/graph/positions?workspace=../evil", { [node.id]: { x: 1, y: 2 } }));
		assert.equal(bad.status, 404, "the same id guard as every other scoped route");

		const commit = (await positionsRoute.PUT(put(`/api/graph/positions?workspace=${ws.id}`, { [node.id]: { x: 3.5, y: -2 } }))).json() as Promise<{
			positions: Record<string, { x: number; y: number }>;
		}>;
		const body = await commit;
		assert.deepEqual(body.positions[node.id], { x: 3.5, y: -2 });
		// The ledger landed in the workspace's own positions file — never the legacy one.
		const posFile = path.join(PATHS.workspaces, ws.id, "graph", "positions.json");
		assert.ok(fs.existsSync(posFile), "workspace positions live in the workspace folder (decision 8)");
		assert.deepEqual(stores.graphStore.readPositions()[node.id], undefined, "the legacy ledger stayed clean");
	});

	it("DELETE /api/graph/nodes/[id]: the node dies in the SELECTED graph; scoped stamps move", async () => {
		const ws = mkWorkspace("Selector delete");
		mergeMarker(ws.id, "Doomed marker");
		const graphStore = graphStoresForChat.forWorkspace(ws.id);
		const doomed = graphStore.readNodes().find((n) => n.name === "Doomed marker")!;

		const legacyBefore = stores.graphStore.readNodes();
		assert.equal(legacyBefore.some((n) => n.name === "Doomed marker"), false, "the node lives in the workspace graph, not the legacy one");

		const bad = await nodeRoute.DELETE(
			new Request(`http://test/api/graph/nodes/${doomed.id}?workspace=zz`, { method: "DELETE" }),
			params(doomed.id),
		);
		assert.equal(bad.status, 404, "unknown workspace gates before the deletion runs");

		const scoped = await nodeRoute.DELETE(
			new Request(`http://test/api/graph/nodes/${doomed.id}?workspace=${ws.id}`, { method: "DELETE" }),
			params(doomed.id),
		);
		assert.equal(scoped.status, 200);
		const body = (await scoped.json()) as { graphRevision: number };
		assert.ok(body.graphRevision > 0, "the scoped stamp moved with the deletion");

		// The node died in ITS graph; the legacy graph never saw it.
		assert.equal(graphStore.readNodes().some((n) => n.name === "Doomed marker"), false);
		assert.equal(stores.graphStore.readNodes().some((n) => n.name === "Doomed marker"), false);

		// Absent selector = the legacy graph's full-death path (byte-identical
		// pre-Phase-6 behavior): a legacy node id deletes from data/graph/.
		const missing = await nodeRoute.DELETE(
			new Request(`http://test/api/graph/nodes/n_99${Date.now()}`, { method: "DELETE" }),
			params("n_99"),
		);
		assert.equal(missing.status, 404, "the legacy graph has no such node — honest 404");
	});
});

// ─── 2. THE SCOPED STAMPS: session deletion + move transport ────────────────

describe("scoped graph stamps (Phase 6): deletion rides the graph it purged", () => {
	it("DELETE /api/chats/:id — a workspace session's stamp IS its workspace's stamp", async () => {
		const ws = mkWorkspace("Selector purge");
		mergeMarker(ws.id, "Purge marker");
		const chatId = created.find((id) => chatStore.getChat(id)?.workspaceId === ws.id)!;

		const res = await chatIdRoute.DELETE(
			new Request(`http://test/api/chats/${chatId}?mode=delete-nodes`, { method: "DELETE" }),
			params(chatId),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { graphRevision: number };
		const wsStamp = (await import("../src/server/graph.ts")).graphRevision(ws.id);
		assert.ok(body.graphRevision >= 0);
		assert.ok(
			body.graphRevision <= wsStamp + 60_000 && body.graphRevision >= wsStamp - 60_000,
			"the delete response carries the workspace directory's stamp (± minute — fs mtime precision)",
		);
	});

	it("move-nodes stamps name their origin/destination graphs (Phase 5 seam, Phase 6 scope pins)", async () => {
		const from = mkWorkspace("Selector move from");
		const to = mkWorkspace("Selector move to");
		mergeMarker(from.id, "Moved marker");
		const chatId = created.find((id) => chatStore.getChat(id)?.workspaceId === from.id)!;

		const route = await import("../app/api/chats/[id]/workspace/route.ts");
		const res = await route.PUT(put(`/api/chats/${chatId}/workspace?mode=move-nodes`, { workspaceId: to.id }), params(chatId));
		assert.equal(res.status, 200);
		const body = (await res.json()) as {
			originGraphRevision: number;
			originScope: string | null;
			destinationGraphRevision: number;
			destinationScope: string | null;
		};
		assert.equal(body.originScope, from.id, "the origin stamp names the workspace graph it was read from");
		assert.equal(body.destinationScope, to.id, "the destination stamp names the graph it landed in");
	});
});

// ─── 3. THE CLIENT SELECTOR SEAM (pure pins) ────────────────────────────────

const { cameraStorageKey, readGraphWorkspaceScope, graphScopeOptions, graphScopedUrl, GraphChromeRow, GRAPH_WORKSPACE_STORAGE_KEY } = await import(
	"../components/graph-view.tsx"
);
const { deleteNodeUrl } = await import("../components/delete-node-dialog.tsx");
const { announceScopedRevision } = await import("../components/chain-table.tsx");

describe("the selector's pure seam (Phase 6)", () => {
	it("lh:graph-workspace reads honestly — only a workspace id counts; everything else is Global", () => {
		assert.equal(readGraphWorkspaceScope(null), null, "absent = the pre-Phase-6 default");
		assert.equal(readGraphWorkspaceScope(""), null);
		assert.equal(readGraphWorkspaceScope("global"), null, "the legacy spelling rides null (storage holds only workspace ids)");
		assert.equal(readGraphWorkspaceScope("ws_abc123"), "ws_abc123");
		assert.equal(readGraphWorkspaceScope("../evil"), null, "a path-traveling value never reaches a store");
		assert.equal(GRAPH_WORKSPACE_STORAGE_KEY, "lh.graph-workspace", "the persisted key (decision C1)");
	});

	it("the option list: Global first, workspaces in store order, Unsorted NEVER an option", () => {
		const options = graphScopeOptions([
			{ id: "ws_a", name: "Linear Algebra" },
			{ id: "ws_b", name: "Music" },
		]);
		assert.deepEqual(options, [
			{ workspaceId: null, label: "Global (legacy)" },
			{ workspaceId: "ws_a", label: "Linear Algebra" },
			{ workspaceId: "ws_b", label: "Music" },
		]);
		assert.equal(graphScopeOptions([]).length, 1, "no workspaces yet = only Global");
	});

	it("camera memory is per scope (owner ruling): bare key for Global, a suffix for every workspace", () => {
		assert.equal(cameraStorageKey(null), "lh.graph.camera.v1", "the legacy shape is untouched");
		assert.equal(cameraStorageKey(undefined), "lh.graph.camera.v1");
		assert.equal(cameraStorageKey("ws_a"), "lh.graph.camera.v1:ws_a");
	});

	it("SSR chrome pin: the selector renders even on an EMPTY graph — it is a real action there", () => {
		const PROPS = {
			query: "",
			onQuery: () => {},
			noMatch: false,
			importing: false,
			searchInputRef: { current: null },
			fileInputRef: { current: null },
			onImportFiles: () => {},
			settings: {} as GraphRenderSettings,
			changeSettings: () => {},
			onOpenChains: () => {},
		};
		const selector = React.createElement("span", { "data-testid": "scope-selector" }, "Global (legacy)");
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: true, scopeSelector: selector }),
		);
		assert.ok(html.includes('data-testid="scope-selector"'), "the selector is NOT a lie on an empty graph");
		assert.ok(html.includes('data-testid="import-notes"'), "Import Notes still renders (the entry point)");
	});

	it("every scoped client seam rides the same URL contract the routes gate (?workspace=<id>; absent = the bare legacy URL)", () => {
		// The graph view's reads: snapshot, costs, positions commit.
		assert.equal(graphScopedUrl("/api/graph", null), "/api/graph", "Global rides today's bare URL (byte-identical pre-Phase-6 fetch)");
		assert.equal(graphScopedUrl("/api/graph/costs", null), "/api/graph/costs");
		assert.equal(graphScopedUrl("/api/graph/positions", null), "/api/graph/positions");
		// A selected workspace: the scoped spelling, id encoded honestly.
		assert.equal(graphScopedUrl("/api/graph", "ws_abc"), "/api/graph?workspace=ws_abc");
		assert.equal(graphScopedUrl("/api/graph/costs", "ws_abc123"), "/api/graph/costs?workspace=ws_abc123");
		assert.equal(graphScopedUrl("/api/graph/positions", "ws-weird-name"), "/api/graph/positions?workspace=ws-weird-name");
		// The node DELETE seam (delete-node-dialog): the scoped query rides a "?"
		// (the URL carries no other query — a "&" there would be a dead gate).
		assert.equal(deleteNodeUrl("kepler", null), "/api/graph/nodes/kepler", "Global = the bare legacy DELETE (pre-Phase-6 shape)");
		assert.equal(deleteNodeUrl("kepler", undefined), "/api/graph/nodes/kepler");
		assert.equal(deleteNodeUrl("n_a1", "ws_abc"), "/api/graph/nodes/n_a1?workspace=ws_abc");
		assert.equal(deleteNodeUrl("id with spaces", "ws_x"), "/api/graph/nodes/id%20with%20spaces?workspace=ws_x", "both halves encode honestly");
	});

	it("the scoped deletion announcement names the graph the deaths happened IN (chain-table + graph-view seam)", async () => {
		// linkedom window: the announce seam dispatches on window exactly as the
		// browser does; graphRevisionScopeMatches governs which view refetches.
		const { parseHTML } = await import("linkedom");
		const dom = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { window: dom.window, CustomEvent: dom.window.CustomEvent });
		const seen: unknown[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent).detail);
		dom.window.addEventListener("lh:graph-revision", listener);
		try {
			announceScopedRevision(7, "ws_abc");
			announceScopedRevision(8, null);
			announceScopedRevision(9, undefined);
		} finally {
			dom.window.removeEventListener("lh:graph-revision", listener);
		}
		assert.deepEqual(seen, [
			{ revision: 7, scope: "ws_abc" },
			{ revision: 8, scope: null },
			{ revision: 9, scope: null },
		], "the workspace stamp carries its scope; the legacy stamp rides scope:null (graphRevisionScopeMatches governs who refetches)");
	});
});
