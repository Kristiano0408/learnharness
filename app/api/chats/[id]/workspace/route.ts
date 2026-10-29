import { moveChatSessionGraph } from "@/src/server";
import type { ChatMoveMode } from "@/src/core";

/**
 * Move a session between workspaces (workspace wave Phase 2 + Phase 5,
 * docs/workspaces.md): the sidebar's "Move to workspace…" dialog commits
 * here. Body: { workspaceId } — a workspace id, or null for Unsorted.
 * Query: ?mode=move-session|move-nodes (absent = move-session).
 *
 * The gates (src/server/workspaces.ts moveChatSessionGraph): 404 unknown
 * session, 400 unknown workspace, 409 while a turn or the session's
 * extraction is in flight (both persist the record read-modify-write —
 * a filing write racing either would clobber it; retryable). Phase 5's
 * transport: mode=move-nodes rides the A3 dialog's traces checkbox and
 * carries the session's graph traces to the destination graph (the origin
 * loses them, fully-owned nodes die there); an Unsorted destination has no
 * graph — honest 400 refusal ("no_graph_destination").
 *
 * The move-nodes success carries the transport stats + both revised graph
 * stamps (origin/destination) — the scoped refetch signal the sidebar
 * announces as lh:graph-revision.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const modeParam = new URL(req.url).searchParams.get("mode");
	if (modeParam !== null && modeParam !== "move-session" && modeParam !== "move-nodes") {
		return Response.json(
			{ error: 'mode must be "move-session" or "move-nodes"', code: "bad_mode" },
			{ status: 400 },
		);
	}
	const body = (await req.json().catch(() => null)) as { workspaceId?: unknown } | null;
	if (body === null || !("workspaceId" in body)) {
		return Response.json({ error: 'body must carry "workspaceId": a workspace id or null', code: "bad_body" }, { status: 400 });
	}
	const workspaceId = body.workspaceId;
	if (workspaceId !== null && typeof workspaceId !== "string") {
		return Response.json({ error: "workspaceId must be a string or null", code: "bad_body" }, { status: 400 });
	}
	const outcome = moveChatSessionGraph(id, (modeParam ?? "move-session") as ChatMoveMode, workspaceId);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({
		ok: true,
		mode: outcome.mode,
		workspaceId: outcome.workspaceId,
		...(outcome.stats !== null ? { stats: outcome.stats } : {}),
		originGraphRevision: outcome.originGraphRevision,
		originScope: outcome.originScope,
		destinationGraphRevision: outcome.destinationGraphRevision,
		destinationScope: outcome.destinationScope,
	});
}
