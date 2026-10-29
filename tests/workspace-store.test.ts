/**
 * WORKSPACE STORE (workspace wave Phase 1, docs/workspaces.md): the fs
 * adapter's contract — create/get/list/rename/delete, the id guard, the
 * lazy version stamp + newer-stamp refusal, the corrupt-shape guard, and
 * the list-SHAPE event law (create/rename/delete announce
 * workspaces-changed; nothing else exists yet to be silent about).
 * Runs under an isolated LH_DATA_DIR (the chat-store-events discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { workspaceStore } = await import("../src/store/workspaces.ts");
const { subscribe } = await import("../src/core/events.ts");
const { PATHS } = await import("../config.ts");
const { CURRENT_WORKSPACE_VERSION } = await import("../src/core/contracts.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("workspace store (Phase 1)", () => {
	it("createWorkspace persists meta.json under data/workspaces/<id>/ and stamps the version", () => {
		const ws = workspaceStore.createWorkspace("Linear Algebra");
		assert.match(ws.id, /^ws_[a-z0-9]+_[a-z0-9-]+$/);
		assert.equal(ws.name, "Linear Algebra");
		assert.equal(ws.version, CURRENT_WORKSPACE_VERSION, "the in-memory twin carries the stamp");

		const file = path.join(PATHS.workspaces, ws.id, "meta.json");
		assert.ok(fs.existsSync(file), "the record landed on disk");
		const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.equal(onDisk.version, CURRENT_WORKSPACE_VERSION, "the write choke point stamps every write");

		const read = workspaceStore.getWorkspace(ws.id);
		assert.ok(read, "the record reads back");
		assert.equal(read.name, "Linear Algebra");

		assert.equal(workspaceStore.deleteWorkspace(ws.id), true);
	});

	it("empty name falls back to the honest floor", () => {
		const ws = workspaceStore.createWorkspace("   ");
		assert.equal(ws.name, "Untitled workspace");
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("listWorkspaces returns records oldest-first, skipping corrupt entries", async () => {
		const a = workspaceStore.createWorkspace("A");
		// Spaced creations so the createdAt order is unambiguous; same-ms
		// ties resolve deterministically via the store's id tiebreak.
		await new Promise((resolve) => setTimeout(resolve, 2));
		const b = workspaceStore.createWorkspace("B");

		// A corrupt directory inside data/workspaces/ must not blank the list.
		const junkDir = path.join(PATHS.workspaces, "ws_junk");
		fs.mkdirSync(junkDir, { recursive: true });
		fs.writeFileSync(path.join(junkDir, "meta.json"), "{ not json", "utf-8");
		// A directory without a meta.json reads as absent too.
		fs.mkdirSync(path.join(PATHS.workspaces, "ws_no_meta"), { recursive: true });

		const list = workspaceStore.listWorkspaces();
		assert.deepEqual(
			list.map((w) => w.id),
			[a.id, b.id],
			"oldest first; corrupt/shapeless entries are skipped, never guessed at",
		);

		workspaceStore.deleteWorkspace(a.id);
		workspaceStore.deleteWorkspace(b.id);
		fs.rmSync(junkDir, { recursive: true, force: true });
		fs.rmSync(path.join(PATHS.workspaces, "ws_no_meta"), { recursive: true, force: true });
	});

	it("renameWorkspace keeps createdAt/updatedAt frozen (a rename is not activity)", () => {
		const ws = workspaceStore.createWorkspace("Before");
		const before = workspaceStore.getWorkspace(ws.id)!;
		const renamed = workspaceStore.renameWorkspace(ws.id, "  After  ");
		assert.equal(renamed.name, "After", "trim, like every rename in the app");
		const after = workspaceStore.getWorkspace(ws.id)!;
		assert.equal(after.updatedAt, before.updatedAt, "updatedAt stays put — list order must not churn");
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("renameWorkspace on a missing id throws; empty rename hits the floor", () => {
		assert.throws(() => workspaceStore.renameWorkspace("ws_never_existed", "x"), /Workspace not found/);
		const ws = workspaceStore.createWorkspace("Something");
		assert.equal(workspaceStore.renameWorkspace(ws.id, "   ").name, "Untitled workspace");
		workspaceStore.deleteWorkspace(ws.id);
	});

	it("deleteWorkspace on a missing id returns false and stays silent", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "workspaces-changed") announces++;
		});
		assert.equal(workspaceStore.deleteWorkspace("ws_never_existed"), false);
		assert.equal(announces, 0, "nothing was written — nothing announced (the present-entry law)");
		off();
	});

	it("a record stamped NEWER than this build refuses on read (the downgrade guard)", () => {
		const ws = workspaceStore.createWorkspace("Future stamp");
		const file = path.join(PATHS.workspaces, ws.id, "meta.json");
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		record.version = CURRENT_WORKSPACE_VERSION + 1;
		fs.writeFileSync(file, JSON.stringify(record, null, "\t"), "utf-8");

		assert.equal(workspaceStore.getWorkspace(ws.id), null, "refused, never misparsed");
		assert.equal(
			workspaceStore.listWorkspaces().some((w) => w.id === ws.id),
			false,
			"the refusal rides the list too",
		);
		// The refusal must not rewrite what it doesn't understand.
		assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).version, CURRENT_WORKSPACE_VERSION + 1);

		fs.rmSync(path.join(PATHS.workspaces, ws.id), { recursive: true, force: true });
	});

	it("an invalid id never resolves outside data/workspaces/ (the path guard)", () => {
		// Same shape as the chat store: the guard throws inside the read, the
		// per-record catch turns it into the honest absent answer — a hostile
		// id must never escape the workspaces directory.
		assert.equal(workspaceStore.getWorkspace("../escape"), null);
		assert.equal(workspaceStore.deleteWorkspace("a/b"), false);
		assert.throws(() => workspaceStore.renameWorkspace("../escape", "x"), /Workspace not found/);
	});

	it("create/rename/delete each announce workspaces-changed (the list-SHAPE law)", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "workspaces-changed") announces++;
		});

		const ws = workspaceStore.createWorkspace("Events fixture");
		assert.equal(announces, 1, "create announces post-write");

		workspaceStore.renameWorkspace(ws.id, "Renamed");
		assert.equal(announces, 2, "rename announces (a list-shape write)");

		assert.equal(workspaceStore.deleteWorkspace(ws.id), true);
		assert.equal(announces, 3, "a real delete announces");
		off();
	});
});
