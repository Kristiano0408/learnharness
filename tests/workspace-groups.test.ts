import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DRAFT_WORKSPACE_KEY,
	FILTER_DEFAULT_KEY,
	UNSORTED_KEY,
	filterChatsByKind,
	groupChatsByWorkspace,
	kindFilterFor,
	readKindFilters,
	withKindFilter,
	writeKindFilters,
} from "../src/core/index.ts";
import type { ChatLike, SessionSection, WorkspaceLike } from "../src/core/index.ts";

/**
 * Workspace wave Phase 3 — the sidebar's section fold (docs/workspaces.md,
 * owner decisions 2026-10-28). The fold is pure core: the sidebar owns the
 * fetches and localStorage, this owns the two folds the render must not
 * re-derive (grouping + the per-section kind filter, decision 4C).
 */

const wsA: WorkspaceLike = { id: "ws_a", name: "Algebra" };
const wsB: WorkspaceLike = { id: "ws_b", name: "Music" };

describe("groupChatsByWorkspace — the section fold", () => {
	it("Unsorted FIRST, only when it holds chats; workspaces after, in store order, INCLUDING empty ones", () => {
		const chats: ChatLike[] = [
			{ workspaceId: wsB.id },
			{ kind: "practice" }, // no workspaceId → Unsorted
			{ workspaceId: wsA.id },
		];
		const sections = groupChatsByWorkspace(chats, [wsA, wsB, { id: "ws_c", name: "Empty" }]);
		assert.deepEqual(sections.map((s) => s.key), [UNSORTED_KEY, wsA.id, wsB.id, "ws_c"]);
		const [unsorted, a, b, empty] = sections as [SessionSection<ChatLike>, SessionSection<ChatLike>, SessionSection<ChatLike>, SessionSection<ChatLike>];
		assert.equal(unsorted.name, "Unsorted");
		assert.equal(unsorted.workspaceId, null);
		assert.equal(a.chats.length, 1);
		assert.equal(b.chats.length, 1);
		assert.equal(empty.chats.length, 0); // a created workspace stays visible
	});

	it("no chats at all → no Unsorted section (empty Unsorted is noise)", () => {
		const sections = groupChatsByWorkspace([], [wsA]);
		assert.deepEqual(sections.map((s) => s.key), [wsA.id]);
	});

	it("a chat filed under a workspace that no longer exists reads as Unsorted — honest, never dropped", () => {
		const chats: ChatLike[] = [{ workspaceId: "ws_ghost" }, { workspaceId: wsA.id }];
		const sections = groupChatsByWorkspace(chats, [wsA]);
		assert.equal(sections[0]?.key, UNSORTED_KEY);
		assert.equal(sections[0]?.chats.length, 1);
		assert.equal(sections[1]?.chats.length, 1);
	});

	it("the order INSIDE a section is the incoming list order (updatedAt desc — today's order, unchanged)", () => {
		const chats: ChatLike[] = [{ workspaceId: wsA.id, kind: "teach" }, { workspaceId: wsA.id, kind: "practice" }];
		const sections = groupChatsByWorkspace(chats, [wsA]);
		assert.equal(sections[0]?.chats[0]?.kind, "teach");
		assert.equal(sections[0]?.chats[1]?.kind, "practice");
	});
});

describe("The per-section kind filter (decision 4C)", () => {
	it("the legacy bare string (the pre-workspace global filter) migrates lazily to the \"*\" default", () => {
		for (const legacy of ["teach", "all", "practice"] as const) {
			const filters = readKindFilters(legacy);
			assert.deepEqual(filters, { [FILTER_DEFAULT_KEY]: legacy });
			// every untouched section keeps the behavior the user had
			assert.equal(kindFilterFor(filters, wsA.id), legacy);
			assert.equal(kindFilterFor(filters, UNSORTED_KEY), legacy);
		}
	});

	it("corrupt / unknown reads as {} — every section defaults to \"all\" (absence never changes behavior)", () => {
		for (const raw of [null, "", "nonsense", "{broken", '["teach"]', '{"a": 1}']) {
			const filters = readKindFilters(raw);
			assert.equal(kindFilterFor(filters, "whatever"), "all");
		}
		// unknown entries inside a valid map are dropped, known ones kept
		const filters = readKindFilters('{"ws_a": "practice", "ws_b": 42}');
		assert.deepEqual(filters, { ws_a: "practice" });
	});

	it("round-trips through writeKindFilters", () => {
		const filters = withKindFilter(readKindFilters(null), wsA.id, "teach");
		const back = readKindFilters(writeKindFilters(filters));
		assert.deepEqual(back, filters);
		assert.equal(kindFilterFor(back, wsA.id), "teach");
		assert.equal(kindFilterFor(back, wsB.id), "all"); // the section without a pick defaults
	});

	it("withKindFilter is immutable (the persisted snapshot never mutates)", () => {
		const base = { [FILTER_DEFAULT_KEY]: "practice" as const };
		const next = withKindFilter(base, wsA.id, "teach");
		assert.notEqual(base, next);
		assert.equal(base[FILTER_DEFAULT_KEY], "practice");
	});

	it("filterChatsByKind: absent kind reads as teach (the ChatSummary contract); \"all\" passes everything", () => {
		const chats: ChatLike[] = [{}, { kind: "teach" }, { kind: "practice" }];
		assert.equal(filterChatsByKind(chats, "teach").length, 2);
		assert.equal(filterChatsByKind(chats, "practice").length, 1);
		assert.equal(filterChatsByKind(chats, "all").length, 3);
		// "all" returns a copy, never the caller's array
		const all = filterChatsByKind(chats, "all");
		assert.notEqual(all, chats);
	});
});

it("DRAFT_WORKSPACE_KEY is the single draft-filing key (no duplicate lives in components)", () => {
	assert.equal(DRAFT_WORKSPACE_KEY, "lh:draft-workspace");
});
