import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	KindFilterRow,
	NewWorkspaceRow,
	WorkspaceDeleteConfirm,
	WorkspaceRenameRow,
	WorkspaceSectionHeader,
} from "../components/sidebar.tsx";
import { MoveSessionBody, MoveSessionDialog, MOVE_TRACES_COPY } from "../components/move-session-dialog.tsx";
import { UNSORTED_KEY } from "../src/core/index.ts";
import type { WorkspaceListItem } from "../src/core/index.ts";

/**
 * Workspace wave Phase 3 — the sidebar's workspace UI seams (SSR pins, the
 * delete-dialog pattern: portals no-op in SSR, so the pure bodies carry the
 * testids the integration walks depend on).
 */

const ws: WorkspaceListItem = {
	id: "ws_a",
	name: "Algebra",
	createdAt: "2026-10-28T00:00:00.000Z",
	updatedAt: "2026-10-28T00:00:00.000Z",
	sessionCount: 3,
	busyCount: 0,
};

describe("WorkspaceSectionHeader — the section seam", () => {
	it("carries the section/collapse/name testids keyed by section key", () => {
		const html = renderToStaticMarkup(
			<WorkspaceSectionHeader
				section={{ key: "ws_a", name: "Algebra", workspaceId: "ws_a", chats: [1, 2, 3] }}
				collapsed={false}
				busyCount={0}
				onToggle={() => {}}
				onRename={() => {}}
				onDelete={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="workspace-section-ws_a"'));
		assert.ok(html.includes('data-testid="workspace-collapse-ws_a"'));
		assert.ok(html.includes('data-testid="workspace-name-ws_a"'));
		assert.ok(html.includes("Algebra"));
		assert.ok(html.includes(">3<"), "the session count rides the header");
	});

	it("the Unsorted section carries NO rename/delete — a fallback grouping, not a record", () => {
		const html = renderToStaticMarkup(
			<WorkspaceSectionHeader
				section={{ key: UNSORTED_KEY, name: "Unsorted", workspaceId: null, chats: [1] }}
				collapsed={false}
				busyCount={0}
				onToggle={() => {}}
				onRename={() => {}}
				onDelete={() => {}}
			/>,
		);
		assert.ok(!html.includes("workspace-rename-"));
		assert.ok(!html.includes("workspace-delete-"));
	});

	it("a real workspace carries the hover rename/delete pair (danger last — the danger-fence law)", () => {
		const html = renderToStaticMarkup(
			<WorkspaceSectionHeader
				section={{ key: "ws_a", name: "Algebra", workspaceId: "ws_a", chats: [] }}
				collapsed={true}
				busyCount={0}
				onToggle={() => {}}
				onRename={() => {}}
				onDelete={() => {}}
			/>,
		);
		const rename = html.indexOf('data-testid="workspace-rename-ws_a"');
		const del = html.indexOf('data-testid="workspace-delete-ws_a"');
		assert.ok(rename > 0 && del > rename, "delete sits after rename");
	});
});

describe("KindFilterRow — the per-section filter (decision 4C)", () => {
	it("three options keyed by section key", () => {
		const html = renderToStaticMarkup(
			<KindFilterRow sectionKey="ws_a" filter="teach" onFilter={() => {}} />,
		);
		assert.ok(html.includes('data-testid="kind-filter-ws_a"'));
		for (const f of ["teach", "practice", "all"]) {
			assert.ok(html.includes(`data-testid="kind-filter-ws_a-${f}"`));
		}
	});
});

describe("Workspace rename / delete / create rows", () => {
	it("the rename row drafts from the current name", () => {
		const html = renderToStaticMarkup(
			<WorkspaceRenameRow name="Algebra" onCommit={() => {}} onCancel={() => {}} />,
		);
		assert.ok(html.includes('data-testid="workspace-rename-input"'));
		assert.ok(html.includes('value="Algebra"'));
	});

	it("the delete confirm names the workspace and fences the destructive action last", () => {
		const html = renderToStaticMarkup(
			<WorkspaceDeleteConfirm name="Algebra" onConfirm={() => {}} onCancel={() => {}} />,
		);
		assert.ok(html.includes('data-testid="workspace-delete-confirm"'));
		const cancel = html.indexOf('data-testid="workspace-delete-cancel"');
		const confirm = html.indexOf('data-testid="workspace-delete-confirm-button"');
		assert.ok(cancel > 0 && confirm > cancel);
	});

	it("the new-workspace row starts empty", () => {
		const html = renderToStaticMarkup(<NewWorkspaceRow onCommit={() => {}} onCancel={() => {}} />);
		assert.ok(html.includes('data-testid="new-workspace-input"'));
		assert.ok(html.includes('value=""'));
	});
});

describe("MoveSessionDialog — the move seam (Phase 3: session-only; Phase 5 adds graph traces)", () => {
	it("closed (chat=null) renders nothing", () => {
		assert.equal(renderToStaticMarkup(<MoveSessionDialog chat={null} workspaces={[]} onClose={() => {}} onMoved={() => {}} />), "");
	});

	it("the body lists every destination + Unsorted, with the session counts", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics", workspaceId: "ws_a" }}
				workspaces={[ws, { ...ws, id: "ws_b", name: "Music", sessionCount: 0 }]}
				target={UNSORTED_KEY}
				traces={false}
				busy={false}
				failure={null}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="move-session-dialog"'));
		assert.ok(html.includes("Wave mechanics"));
		assert.ok(html.includes('data-testid="move-destination-ws_a"'));
		assert.ok(html.includes('data-testid="move-destination-ws_b"'));
		assert.ok(html.includes(`data-testid="move-destination-${UNSORTED_KEY}"`));
		assert.ok(html.includes("3 sessions"));
		assert.ok(html.includes("0 sessions"));
		assert.ok(html.includes('data-testid="move-commit"'));
	});

	it("the destination list excludes the session's CURRENT workspace (the caller filters — the body renders what it is given)", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics", workspaceId: "ws_a" }}
				workspaces={[{ ...ws, id: "ws_b", name: "Music" }]}
				target="ws_b"
				traces={false}
				busy={false}
				failure={null}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.ok(!html.includes('data-testid="move-destination-ws_a"'));
	});

	it("a server failure surfaces as an alert (the 409 turn_in_flight copy is the server's)", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics" }}
				workspaces={[ws]}
				target="ws_a"
				traces={false}
				busy={false}
				failure={{ code: "turn_in_flight", error: "A turn is running — stop it before moving." }}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes("stop it before moving"));
	});

	it("Phase 5: a workspace destination renders the traces checkbox with the delete dialog's copy shape (unchecked default is the caller's state)", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics", workspaceId: "ws_a" }}
				workspaces={[{ ...ws, id: "ws_b", name: "Music" }]}
				target="ws_b"
				traces={false}
				busy={false}
				failure={null}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.ok(html.includes(`data-testid="${MOVE_TRACES_COPY.testid}"`));
		assert.ok(html.includes(`data-testid="${MOVE_TRACES_COPY.checkbox}"`));
		assert.ok(html.includes(MOVE_TRACES_COPY.title), "the title mirrors 'Also remove its graph traces'");
		assert.ok(html.includes(MOVE_TRACES_COPY.body), "the honest body copy rides design, not implementation");
		assert.ok(!html.includes("move-traces-unsorted"), "the unsorted line only rides an Unsorted destination");
	});

	it("Phase 5: the checkbox rides a checked state too (the checked mode is the caller's to derive)", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics", workspaceId: "ws_a" }}
				workspaces={[{ ...ws, id: "ws_b", name: "Music" }]}
				target="ws_b"
				traces={true}
				busy={false}
				failure={null}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.match(html, /data-testid="move-traces-checkbox"[^>]*checked/, "the checked state reaches the input");
	});

	it("Phase 5: toward Unsorted the checkbox stays visible but DISABLED (decision 9: no graph destination), with the honest line in its body", () => {
		const html = renderToStaticMarkup(
			<MoveSessionBody
				chat={{ id: "c1", title: "Wave mechanics", workspaceId: "ws_a" }}
				workspaces={[{ ...ws, id: "ws_b", name: "Music" }]}
				target={UNSORTED_KEY}
				traces={false}
				busy={false}
				failure={null}
				onTarget={() => {}}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);
		assert.ok(html.includes(`data-testid="${MOVE_TRACES_COPY.testid}"`), "the control itself never vanishes — only its state changes");
		assert.match(html, /data-testid="move-traces-checkbox"[^>]*disabled/, "an Unsorted destination cannot strand traces");
		assert.ok(html.includes('data-testid="move-traces-unsorted"'), "the honest line names the missing graph destination");
		assert.ok(html.includes("Unsorted has no graph"), "and says it plainly");
		assert.ok(!html.includes(MOVE_TRACES_COPY.body), "the workspace body copy does not show toward Unsorted");
	});
});
