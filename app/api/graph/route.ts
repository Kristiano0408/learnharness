import { graphView } from "@/src/server";
import { WORKSPACE_ID_PATTERN } from "@/config.ts";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	// THE WORKSPACE SELECTOR (Phase 6, decision C1): ?workspace=<id> reads that
	// workspace's graph; absent/"global" = the legacy global graph
	// (data/graph/) — today's default, behavior invariato per compatibilita.
	// A syntactically-valid id this build can't back reads honestly empty
	// (src/server/graph.ts scopedReadStore) — only a malformed id 404s.
	const url = new URL(request.url);
	const raw = url.searchParams.get("workspace");
	if (raw !== null && raw !== "global" && !WORKSPACE_ID_PATTERN.test(raw)) {
		return Response.json({ error: "unknown workspace", code: "unknown_workspace" }, { status: 404 });
	}
	return Response.json(graphView(raw ?? undefined));
}
