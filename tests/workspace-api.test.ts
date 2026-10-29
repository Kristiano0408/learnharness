/**
 * WORKSPACE API (workspace wave Phase 2, docs/workspaces.md): the filing
 * routes end-to-end — /api/workspaces CRUD (the not_empty delete gate),
 * the POST /api/chats filing gate (unknown workspaceId → 400, absent =
 * Unsorted), the per-chat workspace PUT (move between workspaces / back
 * to Unsorted), and the list folds (sessionCount on the workspace row,
 * workspaceId riding the chat summary).
 *
 * Drives the actual route handlers (framework-free Request/Response)
 * under an isolated LH_DATA_DIR — the seam is set before the first
 * import that transitively loads config.ts, so every app-module import
 * is dynamic (the birth-stamp discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-api-"));
process.env.LH_DATA_DIR = TMP_DATA;

const workspacesRoute = await import("../app/api/workspaces/route.ts");
const workspaceIdRoute = await import("../app/api/workspaces/[id]/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const chatWorkspaceRoute = await import("../app/api/chats/[id]/workspace/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { workspaceStore } = await import("../src/store/workspaces.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function jsonReq(url: string, method: string, body?: unknown): Request {
	return new Request(`http://test${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

function params(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

describe("workspaces CRUD routes (Phase 2)", () => {
	it("POST /api/workspaces: the shape gate + a created workspace", async () => {
		const bad = await workspacesRoute.POST(jsonReq("/api/workspaces", "POST", { name: "   " }));
		assert.equal(bad.status, 400, "empty-after-trim name refuses (the chat-rename floor)");
		assert.equal((await bad.json()).error, "name must be a non-empty string");

		const res = await workspacesRoute.POST(jsonReq("/api/workspaces", "POST", { name: " Category Theory " }));
		assert.equal(res.status, 200);
		const { id, name } = (await res.json()) as { id: string; name: string };
		assert.equal(name, "Category Theory", "trim on write");
		assert.match(id, /^ws_/);

		// GET carries the row with the folds (0 sessions, 0 busy — no turns run here).
		const list = await workspacesRoute.GET();
		const { workspaces } = (await list.json()) as { workspaces: Array<{ id: string; sessionCount: number; busyCount: number }> };
		assert.deepEqual(workspaces.map((w) => w.id), [id]);
		assert.equal(workspaces[0]!.sessionCount, 0);
		assert.equal(workspaces[0]!.busyCount, 0);

		assert.equal(workspaceStore.deleteWorkspace(id), true);
	});

	it("PUT /api/workspaces/[id]: rename (404 unknown, 400 empty, name returned)", async () => {
		const ws = workspaceStore.createWorkspace("Before");

		const missing = await workspaceIdRoute.PUT(jsonReq(`/api/workspaces/nope`, "PUT", { name: "x" }), params("ws_never_existed"));
		assert.equal(missing.status, 404);

		const empty = await workspaceIdRoute.PUT(jsonReq(`/api/workspaces/${ws.id}`, "PUT", { name: "  " }), params(ws.id));
		assert.equal(empty.status, 400);

		const res = await workspaceIdRoute.PUT(jsonReq(`/api/workspaces/${ws.id}`, "PUT", { name: " After " }), params(ws.id));
		assert.equal(res.status, 200);
		assert.equal((await res.json()).name, "After");

		assert.equal(workspaceStore.deleteWorkspace(ws.id), true);
	});

	it("DELETE /api/workspaces/[id]: 404 unknown, 409 not_empty, empty dies", async () => {
		const missing = await workspaceIdRoute.DELETE(jsonReq("/api/workspaces/nope", "DELETE"), params("ws_never_existed"));
		assert.equal(missing.status, 404);

		const ws = workspaceStore.createWorkspace("Has a session");
		const chat = chatStore.createChat("Filed session", undefined, ws.id);

		const refused = await workspaceIdRoute.DELETE(jsonReq(`/api/workspaces/${ws.id}`, "DELETE"), params(ws.id));
		assert.equal(refused.status, 409, "v1: a non-empty workspace refuses — no silent cascade");
		const body = await refused.json();
		assert.equal(body.code, "not_empty");
		assert.equal(body.sessionCount, 1);

		// Empty it, then the delete lands.
		chatStore.deleteChat(chat.id);
		const gone = await workspaceIdRoute.DELETE(jsonReq(`/api/workspaces/${ws.id}`, "DELETE"), params(ws.id));
		assert.equal(gone.status, 200);
		assert.equal((await gone.json()).ok, true);
		assert.equal(workspaceStore.getWorkspace(ws.id), null);
	});
});

describe("session filing routes (Phase 2)", () => {
	it("POST /api/chats: a valid workspaceId files the newborn; unknown refuses 400; absent = Unsorted", async () => {
		const ws = workspaceStore.createWorkspace("Filing target");

		const filed = await chatsRoute.POST(jsonReq("/api/chats", "POST", { title: "teach me limits", workspaceId: ws.id }));
		assert.equal(filed.status, 200);
		const { id } = (await filed.json()) as { id: string };
		assert.equal(chatStore.getChat(id)!.workspaceId, ws.id, "the filing rides the birth");

		const stale = await chatsRoute.POST(jsonReq("/api/chats", "POST", { title: "stale picker", workspaceId: "ws_dead" }));
		assert.equal(stale.status, 400, "a workspaceId must name an existing workspace");
		assert.equal((await stale.json()).code, "unknown_workspace");

		const unsorted = await chatsRoute.POST(jsonReq("/api/chats", "POST", { title: "no filing" }));
		const { id: unsortedId } = (await unsorted.json()) as { id: string };
		assert.equal(chatStore.getChat(unsortedId)!.workspaceId, undefined, "absent = Unsorted (no migration, no default)");

		// The summary carries the filing (the sidebar groups on it).
		const list = await chatsRoute.GET();
		const { chats } = (await list.json()) as { chats: Array<{ id: string; workspaceId?: string }> };
		const byId = new Map(chats.map((c) => [c.id, c]));
		assert.equal(byId.get(id)!.workspaceId, ws.id);
		assert.equal(byId.get(unsortedId)!.workspaceId, undefined);

		// sessionCount folds the filing into the workspace row.
		const { workspaces } = (await (await workspacesRoute.GET()).json()) as { workspaces: Array<{ id: string; sessionCount: number }> };
		assert.equal(workspaces.find((w) => w.id === ws.id)!.sessionCount, 1);

		chatStore.deleteChat(id);
		chatStore.deleteChat(unsortedId);
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("PUT /api/chats/[id]/workspace: move between workspaces, back to Unsorted, gates", async () => {
		const a = workspaceStore.createWorkspace("Workspace A");
		const b = workspaceStore.createWorkspace("Workspace B");
		const chat = chatStore.createChat("Moving session", undefined, a.id);

		// 400: a body without the field, or a non-string/non-null value.
		const noField = await chatWorkspaceRoute.PUT(jsonReq(`/api/chats/${chat.id}/workspace`, "PUT", {}), params(chat.id));
		assert.equal(noField.status, 400);
		const wrongType = await chatWorkspaceRoute.PUT(jsonReq(`/api/chats/${chat.id}/workspace`, "PUT", { workspaceId: 7 }), params(chat.id));
		assert.equal(wrongType.status, 400);

		// 404: unknown session.
		const missing = await chatWorkspaceRoute.PUT(jsonReq("/api/chats/chat_never/workspace", "PUT", { workspaceId: b.id }), params("chat_never"));
		assert.equal(missing.status, 404);

		// 400: unknown destination workspace.
		const unknown = await chatWorkspaceRoute.PUT(jsonReq(`/api/chats/${chat.id}/workspace`, "PUT", { workspaceId: "ws_dead" }), params(chat.id));
		assert.equal(unknown.status, 400);
		assert.equal((await unknown.json()).code, "unknown_workspace");

		// A→B: the filing swaps; updatedAt stays put (a move is not activity).
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const moved = await chatWorkspaceRoute.PUT(jsonReq(`/api/chats/${chat.id}/workspace`, "PUT", { workspaceId: b.id }), params(chat.id));
		assert.equal(moved.status, 200);
		assert.equal((await moved.json()).workspaceId, b.id);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.workspaceId, b.id);
		assert.equal(record.updatedAt, before, "the rename rule: moving must not reorder the list");

		// B→Unsorted: null clears the filing.
		const unsorted = await chatWorkspaceRoute.PUT(jsonReq(`/api/chats/${chat.id}/workspace`, "PUT", { workspaceId: null }), params(chat.id));
		assert.equal(unsorted.status, 200);
		assert.equal((await unsorted.json()).workspaceId, null);
		assert.equal(chatStore.getChat(chat.id)!.workspaceId, undefined, "the field is deleted, not nulled");

		chatStore.deleteChat(chat.id);
		workspaceStore.deleteWorkspace(a.id);
		workspaceStore.deleteWorkspace(b.id);
	});
});
