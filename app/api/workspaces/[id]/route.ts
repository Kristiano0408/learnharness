import { deleteWorkspaceGuarded, getWorkspace, renameWorkspace } from "@/src/server";

/**
 * Rename (workspace wave Phase 2): the sidebar section header's
 * click-to-edit commits here. Same rule as the chat rename — a non-empty
 * string after trim; updatedAt deliberately NOT bumped (rename is not
 * activity).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getWorkspace(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	if (typeof body?.name !== "string" || body.name.trim() === "") {
		return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
	}
	const workspace = renameWorkspace(id, body.name);
	return Response.json({ name: workspace.name });
}

/**
 * DELETE (v1, docs/workspaces.md Phase 2): a workspace with sessions
 * refuses with 409 `not_empty` — moving or deleting its sessions first is
 * the owner's call, never a silent cascade. An empty workspace dies with
 * its directory (Phase 4's graph/ rides along by design).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = deleteWorkspaceGuarded(id);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code, ...("sessionCount" in outcome ? { sessionCount: outcome.sessionCount } : {}) }, { status: outcome.status });
	}
	return Response.json({ ok: true });
}
