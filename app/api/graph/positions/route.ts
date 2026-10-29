/**
 * PUT /api/graph/positions — the live-physics drag commit. The client
 * anneals a drag to rest and sends the new positions; the server
 * sanitizes (finite coords, known ids only), writes the ledger, and if
 * the graph grew mid-drag runs one incremental settle to absorb the new
 * nodes with the client's arrangement as anchors. See
 * src/server/commit-positions.ts.
 *
 *   PUT → 200 {positions: {...}} with whatever survived sanitizing
 *         (empty object = nothing written).
 */
import { commitPositions } from "@/src/server";
import { WORKSPACE_ID_PATTERN } from "@/config.ts";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	// THE WORKSPACE SELECTOR (Phase 6): the positions ledger rides the same
	// selector as the snapshot — absent = legacy global, id = that workspace.
	const url = new URL(request.url);
	const raw = url.searchParams.get("workspace");
	if (raw !== null && !WORKSPACE_ID_PATTERN.test(raw)) {
		return Response.json({ error: "unknown workspace" }, { status: 404 });
	}
	return Response.json({ positions: commitPositions(body, raw ?? undefined) });
}
