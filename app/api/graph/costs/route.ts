/**
 * GET /api/graph/costs — the graph view's cost pill (2026-09 graph cost
 * metrics wave): what the graph PIPELINE cost, folded read-time from the
 * three usage channels (chat extraction runs, notes-source runs,
 * cluster-naming runs). Thin transport over src/server's graphCosts();
 * the fold itself is pure core (core/cost-summary.ts). Dollars are
 * inferred from Pi's catalog/calculator at read time — never stored, so a catalog update
 * re-prices the whole history for free.
 *
 * Scope (user-decided): the graph pipeline ONLY — teaching turns and
 * sub-agent jobs have their own cost channels elsewhere.
 */
import { WORKSPACE_ID_PATTERN } from "@/config";
import { graphCosts } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	// THE WORKSPACE SELECTOR (Phase 6): absent or "global" = the legacy
	// global graph's fold (today's default); a workspace id = that
	// workspace directory's fold.
	const raw = new URL(req.url).searchParams.get("workspace");
	if (raw !== null && raw !== "global" && !WORKSPACE_ID_PATTERN.test(raw)) {
		return Response.json({ error: "Unknown workspace", code: "unknown_workspace" }, { status: 404 });
	}
	return Response.json(graphCosts(raw ?? undefined));
}
