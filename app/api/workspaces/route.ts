import { createWorkspace, listWorkspaceItems } from "@/src/server";

/**
 * The workspace list (workspace wave Phase 2, docs/workspaces.md): the
 * sidebar's sections — records + the server folds (sessionCount,
 * busyCount; the ChatListItem pattern). Oldest-first (the store's
 * createdAt order is the section order).
 */
export async function GET() {
	return Response.json({ workspaces: listWorkspaceItems() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { name?: unknown };
	// The shape gate is the one rule (the chat rename's floor): a non-empty
	// string after trim. The store's "Untitled workspace" floor is never
	// reached from this route.
	if (typeof body.name !== "string" || body.name.trim() === "") {
		return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
	}
	const workspace = createWorkspace(body.name);
	return Response.json({ id: workspace.id, name: workspace.name });
}
