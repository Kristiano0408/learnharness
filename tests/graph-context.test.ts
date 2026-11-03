/**
 * THE GRAPH-CONTEXT MARKER (owner, 2026-10-04 late): a session started
 * with map picks gets its context as a SEPARATE custom message BEFORE
 * the learner's first user message — the picked propositions plus the
 * reasoning chains among them (formatChainLine lines), no more seed
 * text glued into the opening prompt. The model reads the marker's
 * content (toLlmMessages flattens it to a user message like every
 * marker); `details` feeds the transcript's collapsible
 * GraphContextCard (render-practice pins live in the render suite).
 *
 * The route pin drives POST /api/chats under an isolated LH_DATA_DIR
 * (the birth-stamp discipline): picks ride the CREATION, the marker
 * lands as message[0], and the chains derive from the live graph
 * snapshot.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-context-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { newGraphContextMessage } = await import("../src/core/native-messages.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
import type { LhMessage } from "../src/core/native-messages.ts";
const { projectView } = await import("../src/core/view.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { initialPromptOwed } = await import("../components/chat.tsx");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PICKS = [
	{ id: "n_a", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
	{ id: "n_b", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
];

// ── the pure marker ─────────────────────────────────────────────────────────

describe("newGraphContextMessage", () => {
	it("frames the context for the model: propositions listed, chains appended", () => {
		const m = newGraphContextMessage(PICKS, ["Modus ponens → Soundness"]);
		assert.equal(m.customType, "graph-context");
		assert.match(m.content, /\[Session context\] — picked from the learner's knowledge map/);
		// IDS FIRST (owner round 9): every pick carries its id — the problem
		// tool's target field references these; names alone no longer.
		assert.ok(m.content.includes(`- [${PICKS[0]!.id}] Modus ponens: If P implies Q and P holds, Q holds.`));
		assert.ok(m.content.includes("Reasoning chains among them"));
		assert.ok(m.content.includes("- Modus ponens → Soundness"));
		// the UI payload is the structured pick, not the flattened text
		assert.deepEqual(m.details, { propositions: PICKS, chains: ["Modus ponens → Soundness"] });
	});

	it("no chains: the chains section stays out entirely", () => {
		const m = newGraphContextMessage(PICKS, []);
		assert.ok(!m.content.includes("Reasoning chains"));
		assert.deepEqual(m.details, { propositions: PICKS, chains: [] });
	});

	it("toLlmMessages flattens it to a user message (the model's face)", () => {
		const m = newGraphContextMessage(PICKS, ["Modus ponens → Soundness"]);
		const wire = toLlmMessages([m as unknown as LhMessage] as never);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.ok(String((wire[0]!.content as { text?: string }[])[0]!.text).includes("[Session context]"));
	});

	it("projectView: a user-side data part — never a text bubble", () => {
		const m = newGraphContextMessage(PICKS, []);
		const view = projectView([m as unknown as LhMessage] as never);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const part = view[0]!.parts[0] as { type: string; data: unknown };
		assert.equal(part.type, "data-graph-context");
		assert.deepEqual(part.data, m.details);
	});
});

// ── the first-send gate (the dead first turn, owner report 2026-10-04) ──────

describe("initialPromptOwed", () => {
	it("a marker-only record still owes the prompt — scaffolding is not conversation", () => {
		const marker = newGraphContextMessage(PICKS, []);
		assert.equal(initialPromptOwed([marker as never], "drill me on logic"), true);
	});

	it("once a user or assistant message exists, the prompt is spent", () => {
		const marker = newGraphContextMessage(PICKS, []);
		const user = { role: "user" } as never;
		assert.equal(initialPromptOwed([marker as never, user], "drill me"), false);
		assert.equal(initialPromptOwed([{ role: "assistant" } as never], "drill me"), false);
	});

	it("no prompt → nothing owed (the empty-draft case)", () => {
		assert.equal(initialPromptOwed([], undefined), false);
	});
});

// ── the route (picks ride the creation) ─────────────────────────────────────

describe("POST /api/chats — graphContext becomes message[0]", () => {
	it("writes the marker before any user message; chains derive from the live graph", async () => {
		// Seed the map: two picked nodes joined by one chain.
		const node = (id: string, name: string, statement: string) => ({
			id, name, statement, aliases: [] as string[], createdAt: "2026-10-01T00:00:00.000Z", provenance: [],
		});
		graphStore.appendNode(node("n_a", "Modus ponens", "If P implies Q and P holds, Q holds."));
		graphStore.appendNode(node("n_b", "Soundness", "A valid argument from true premises has a true conclusion."));
		graphStore.appendChain({
			id: "arg_1", premises: ["n_a"], conclusion: "n_b",
			provenance: [], createdAt: "2026-10-01T00:00:00.000Z",
		});

		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "drill me on logic",
				kind: "practice",
				graphContext: { propositions: PICKS },
			}),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };

		const record = chatStore.getChat(id)!;
		assert.equal(record.messages.length, 1, "the marker is message[0], alone until the first turn");
		const m = record.messages[0] as { role: string; customType: string; content: string };
		assert.equal(m.role, "custom");
		assert.equal(m.customType, "graph-context");
		assert.ok(m.content.includes("- [n_a] Modus ponens: If P implies Q and P holds, Q holds."));
		// the chain AMONG the picks rides the marker (formatChainLine shape — names)
		assert.ok(m.content.includes("- Modus ponens → Soundness"));
	});

	it("a WORKSPACE session derives its chains from ITS workspace graph (decision 8)", async () => {
		// The pick was made in the workspace's graph view — the propositions and
		// the chain live in data/workspaces/<id>/graph/, NOT the legacy store.
		const node = (id: string, name: string, statement: string) => ({
			id, name, statement, aliases: [] as string[], createdAt: "2026-10-01T00:00:00.000Z", provenance: [],
		});
		const { workspaceStore } = await import("../src/store/workspaces.ts");
		const { graphStoresForChat } = await import("../src/server/stores.ts");
		const ws = workspaceStore.createWorkspace("Logic drills");
		const wsGraph = graphStoresForChat.forWorkspace(ws.id);
		wsGraph.appendNode(node("n_w", "Tautology", "A formula true under every valuation."));
		wsGraph.appendNode(node("n_v", "Validity", "An argument preserving truth from premises to conclusion."));
		wsGraph.appendChain({
			id: "arg_w", premises: ["n_w"], conclusion: "n_v",
			provenance: [], createdAt: "2026-10-01T00:00:00.000Z",
		});

		const res = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "drill tautologies",
				kind: "practice",
				workspaceId: ws.id,
				graphContext: { propositions: [{ id: "n_w", name: "Tautology", statement: "A formula true under every valuation." }] },
			}),
		}));
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		try {
			const record = chatStore.getChat(id)!;
			const m = record.messages[0] as { content: string };
			// The chain among the picks resolves through the WORKSPACE store.
			assert.ok(m.content.includes("- [n_w] Tautology"), "the pick rides the marker");
			// A workspace pick with no picked conclusion yields no chain line —
			// honest (chains ride when BOTH members are picked). Assert against
			// a two-pick variant:
			const res2 = await POST(new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "drill validity",
					kind: "practice",
					workspaceId: ws.id,
					graphContext: { propositions: [
						{ id: "n_w", name: "Tautology", statement: "A formula true under every valuation." },
						{ id: "n_v", name: "Validity", statement: "An argument preserving truth from premises to conclusion." },
					] },
				}),
			}));
			const { id: id2 } = (await res2.json()) as { id: string };
			const m2 = chatStore.getChat(id2)!.messages[0] as { content: string };
			assert.ok(
				m2.content.includes("- Tautology → Validity"),
				"workspace chains derive from the workspace store (never the legacy global graph)",
			);
			fs.unlinkSync(path.join(process.env.LH_DATA_DIR!, "chats", `${id2}.json`));
		} finally {
			workspaceStore.deleteWorkspace(ws.id);
			fs.unlinkSync(path.join(process.env.LH_DATA_DIR!, "chats", `${id}.json`));
		}
	});

	it("no picks (or malformed) → no marker, an empty record as before", async () => {
		for (const body of [{ title: "t" }, { title: "t", graphContext: { propositions: "junk" } }]) {
			const res = await POST(new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}));
			const { id } = (await res.json()) as { id: string };
			assert.equal(chatStore.getChat(id)!.messages.length, 0);
		}
	});
});
