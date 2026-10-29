/**
 * Session deletion — the FIRST destructive operation on the append-only
 * graph ledgers (owner ruling 2026-09-22, wave 6 chunk A).
 *
 * Until now mergeFindings has been the sole writer; deletion is the second,
 * and it is held to the same discipline: PURE code over the storage ports
 * (core/ports.ts), no LLM judgment anywhere, deterministic and idempotent.
 * The caller (the DELETE /api/chats/[id] route through the server
 * orchestration) owns the cross-store choreography (chat record, jobs,
 * extraction wind-down); this module owns the LEDGERS.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the stored truth is propositions +
 * reasoning chains; edges are a derived view. Deletion therefore operates
 * on CHAIN LINES where it used to operate on edge lines — a chain dies
 * when its provenance empties or any member node died — and the derived
 * view follows on the next read, never rewritten here.
 *
 * Two modes (owner-locked semantics):
 *
 *   preserve-graph  the chat's extraction bookkeeping dies — its coverage
 *                   rows and its legacy checkpoint lines — and NOTHING else:
 *                   nodes and chains stay byte-identical.
 *                   The graph keeps the session's contributions; the
 *                   snapshot simply no longer resolves the dead chatId to
 *                   a title (nodeSessions filters unknown ids at read
 *                   time — no UI ghosting).
 *
 *   delete-nodes    "this session never happened": every trace of the
 *                   chat leaves the ledgers — its provenance points on
 *                   every node and chain line, its link lines (their
 *                   phrasings die with them), its coverage/checkpoint
 *                   rows — and orphans die: a node
 *                   whose references all came from this chat disappears
 *                   entirely, pruned from the positions ledger too (dead
 *                   members would break cluster hulls).
 *
 * Shared nodes survive automatically (the ruling): a node lives iff ANY
 * surviving reference remains — a provenance point from another chat or
 * notes source. The create line of a surviving node is special:
 * name/statement/createdAt are the node's IDENTITY — the shared anchor
 * other sessions' link verdicts recognized — so they stay even when the
 * deleted chat created the node; but that session's phrasings (the line's
 * aliases) are stripped and its provenance points removed (owner ruling
 * 2026-09-23: all traces, identity survives).
 *
 * Not touched, by design:
 *   - imported-notes sources (src_…) — a different front door with its
 *     own lifecycle (re-import dedupes by path hash); this wave deletes
 *     CHATS.
 *
 * Resurrection safety: the deletion runs as ONE synchronous block (no
 * awaits — atomic vs the event loop, so no extraction append can
 * interleave), and the extraction pipeline re-checks the chat record
 * before each batch's merge (a deleted chat never merges). Both seams
 * together close every corrupt/resurrect path.
 */

import { randomBytes } from "node:crypto";
import type {
	CoverageEntry,
	GraphChain,
	GraphNode,
	Position,
	SessionCheckpoint,
} from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

/** The two deletion modes (owner-locked 2026-09-22). Machine-checkable on
 *  the API as the required `mode` query param — no default, so no
 *  accidental destructive choice. */
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";

/** What one deletion removed from the ledgers (the DELETE response's
 *  stats; the UI can show "3 topics, 2 links removed" from this). */
export interface ChatDeletionStats {
	/** Distinct nodes that died entirely (all their lines). */
	nodesRemoved: number;
	/** Chain assertion LINES removed (empty-provenance or dead member). */
	chainsRemoved: number;
	/** Coverage rows removed. */
	coverageRemoved: number;
	/** Checkpoint lines removed. */
	checkpointsRemoved: number;
}

const EMPTY_STATS: ChatDeletionStats = {
	nodesRemoved: 0,
	chainsRemoved: 0,
	coverageRemoved: 0,
	checkpointsRemoved: 0,
};

/**
 * Remove one chat's traces from the graph ledgers. Synchronous by design
 * (the atomicity argument above); idempotent (a second run finds nothing
 * and returns zero stats).
 */
export function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats {
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		throw new Error(`Unknown deletion mode: ${mode as string}`);
	}

	// The bookkeeping rows die in BOTH modes — coverage and checkpoints
	// are extraction state, not graph content (owner semantics: even
	// preserve-graph deletes "the chat's coverage rows").
	const coverage = graphStore.readCoverage().filter((row) => row.chatId !== chatId);
	const checkpoints = graphStore.readCheckpoints().filter((row) => row.chatId !== chatId);
	const stats: ChatDeletionStats = {
		...EMPTY_STATS,
		coverageRemoved: graphStore.readCoverage().length - coverage.length,
		checkpointsRemoved: graphStore.readCheckpoints().length - checkpoints.length,
	};

	if (mode === "preserve-graph") {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// ── delete-nodes: the full purge ──────────────────────────────────────
	const nodeLines = graphStore.readNodes();
	const chainLines = graphStore.readChains();

	// Does the chat touch the graph at all? (A never-extracted chat still
	// needs its coverage rows dropped above, but no ledger rewrite — keeps
	// mtimes stable so the graph revision only moves when something really
	// changed.)
	const touched =
		nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
		chainLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId));
	if (!touched) {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// 1. Survival: a node lives iff a reference from ANY surviving source
	//    remains — another chat/src's provenance point on any of its lines.
	//    (Chain members are deliberately NOT survival references: a
	//    chain's asserting session always left provenance on its endpoints,
	//    so endpoint-only liveness cannot occur in a consistent ledger —
	//    and counting it would keep nodes alive whose lines we would then
	//    drop, dangling the chain.)
	const survives = (points: ReadonlyArray<{ chatId: string }>): boolean =>
		points.some((pt) => pt.chatId !== chatId);
	const live = new Set<string>();
	for (const line of nodeLines) {
		if (survives(line.provenance)) live.add(line.id);
	}

	// 2. Node lines. Per-line (each line is ONE extraction run's append, so
	//    per-session alias provenance exists at line granularity):
	//      dead node            every line dies
	//      untouched line        kept verbatim
	//      partially-deleted     kept with the chat's points stripped
	//                           (defensive — single-run lines never mix chats)
	//      all points deleted    CREATE line: identity survives, aliases
	//                           stripped (owner ruling 2026-09-23), points
	//                           empty / LINK line: dies with its phrasings
	const outNodes: GraphNode[] = [];
	const seenIds = new Set<string>();
	for (const line of nodeLines) {
		if (!live.has(line.id)) continue; // the whole node dies
		const first = !seenIds.has(line.id);
		seenIds.add(line.id);
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		if (points.length === line.provenance.length) {
			outNodes.push(line); // untouched by this chat
			continue;
		}
		if (points.length > 0) {
			outNodes.push({ ...line, provenance: points });
			continue;
		}
		if (first) {
			// The create line of a surviving node the deleted chat minted:
			// name/statement/createdAt are the shared identity other
			// sessions recognized — they stay; the session's phrasings and
			// provenance die (all traces, owner 2026-09-23).
			outNodes.push({ ...line, provenance: [], aliases: [] });
		}
		// else: the deleted chat's link line — dies with its phrasings.
	}

	// 3. Chains: strip the chat's points; an assertion dies when its
	//    provenance empties or ANY member node (premise or conclusion)
	//    died IN THIS DELETION. (Only nodes that existed and died count —
	//    a chain whose members never resolved as nodes is foreign data the
	//    deletion leaves alone: destructive rewriting may not exceed the
	//    deleted chat's blast radius.)
	const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
	const outChains: GraphChain[] = [];
	for (const line of chainLines) {
		if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise))) continue;
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		// An assertion dies when THIS deletion empties its provenance — a
		// line that already had no points is foreign/legacy data, not this
		// chat's trace; it rides untouched.
		if (line.provenance.length > 0 && points.length === 0) continue;
		outChains.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
	}

	stats.nodesRemoved = [...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)).length;
	stats.chainsRemoved = chainLines.length - outChains.length;

	graphStore.rewriteLedgers({
		nodes: outNodes,
		chains: outChains,
		coverage,
		checkpoints,
	});

	// 4. Positions: prune dead nodes AND dead chains (an argument's derived
	//    implication node carries the chain's arg_ id — stale resting spots
	//    would pin nothing; pruning keeps the ledger honest and the
	//    revision moving for exactly the right reason).
	const deadChainIds = new Set(
		chainLines
			.filter((line) => !outChains.includes(line))
			.map((line) => line.id),
	);
	const positions = graphStore.readPositions();
	const knownNodeIds = new Set(nodeLines.map((line) => line.id));
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(
			([id]) => (live.has(id) || !knownNodeIds.has(id)) && !deadChainIds.has(id),
		),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return stats;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ───────────

/**
 * FULL DEATH for one node, by id (owner ruling 2026-09-23): the user
 * pointing at the node IS the intent — references from other sessions do
 * NOT preserve it. The remedy for undeletable nodes (preserve-graph
 * orphans from session deletion; notes-import nodes with no chat behind
 * them), and the deliberate inverse of the chat cascade above: that one
 * deletes a SESSION and lets nodes survive on foreign references; this
 * one deletes a NODE and takes its every trace —
 *
 *   - every line of the node (create + link lines)
 *   - every CHAIN referencing it (as premise or conclusion), whatever
 *     session asserted it — a chain with a dead member is not a chain
 *   - its resting position (and every dead chain's)
 *
 * An ARGUMENT deletion is the same call with an arg_-prefixed id (owner,
 * 2026-09-30: the chain table's fenced delete kills chains): the "node"
 * is the derived implication node whose id IS the chain's id.
 *
 * The blast radius is exactly the rows naming the id: other nodes'
 * provenance, aliases, and sessions are untouched (full death is
 * NODE-scoped, not session-scoped), and the source records of notes
 * imports stay (the import's bookkeeping; deleting one proposition is not
 * deleting the file). Derived data needs no pruning: the birth partition
 * derives on read (the cluster shrinks below MIN_CLUSTER_SIZE and stops
 * rendering — fine), and no other consumer indexes nodes by id across
 * ledgers.
 *
 * Synchronous, one rewriteLedgers call, no awaits (the same atomicity
 * argument as the chat cascade); idempotent in the wave-6 sense — a
 * second run finds no lines and changes nothing.
 */
export interface NodeDeletionStats {
	/** Chain assertion LINES removed (every chain referencing the node). */
	chainsRemoved: number;
}

function nodeLinesOf(graphStore: GraphStore, nodeId: string): GraphNode[] {
	return graphStore.readNodes().filter((line) => line.id === nodeId);
}

function chainLinesOf(graphStore: GraphStore, chainId: string): GraphChain[] {
	return graphStore.readChains().filter((line) => line.id === chainId);
}

/**
 * Full-death one node (or one argument, by its arg_ id). Returns null
 * when no such node/chain exists (the orchestration maps that to 404);
 * rewrites only the ledgers that changed (unchanged files keep their
 * mtimes — the version stamp moves only when something really did).
 */
export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null {
	const chainLines = graphStore.readChains();

	// The argument branch: an arg_ id names a CHAIN, not a proposition —
	// its lines die, and that is the whole death (the member propositions
	// survive: deleting an argument spares its premises/conclusion).
	if (nodeId.startsWith("arg_")) {
		const outChains = chainLines.filter((line) => line.id !== nodeId);
		if (outChains.length === chainLines.length) return null; // unknown argument
		graphStore.rewriteLedgers({ chains: outChains });
		const positions = graphStore.readPositions();
		if (positions[nodeId] !== undefined) {
			const { [nodeId]: _dead, ...rest } = positions;
			graphStore.writePositions(rest);
		}
		return { chainsRemoved: chainLines.length - outChains.length };
	}

	const nodeLines = nodeLinesOf(graphStore, nodeId);
	if (nodeLines.length === 0) return null;

	const outChains = chainLines.filter(
		(line) => line.conclusion !== nodeId && !line.premises.includes(nodeId),
	);

	// Only the touched ledgers: the node's own lines always die (its file
	// must move), everything else rewrites only when rows actually drop.
	const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
	graphStore.rewriteLedgers({
		nodes: outNodes,
		...(outChains.length !== chainLines.length ? { chains: outChains } : {}),
	});

	// The resting positions die with the node and every dead chain.
	const deadChainIds = new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id));
	const positions = graphStore.readPositions();
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => id !== nodeId && !deadChainIds.has(id)),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return {
		chainsRemoved: chainLines.length - outChains.length,
	};
}
// ─── session move — the graph-trace transport (workspace wave Phase 5, owner A3 decision 2026-10-28) ──

/**
 * Move one session's graph traces between two graphs (docs/workspaces.md
 * Fase 5, the A3 dialog's second mode: `move-session-and-nodes`). The
 * transfer seam is deliberately a PAIR of pure operations — a TAKE on the
 * origin and a LAND on the destination — never one rewrite across two
 * stores:
 *
 *   takeChatTraces(graph, chatId)
 *       exactly the delete-nodes semantics (the provenance points die, the
 *       session's link lines die with their phrasings, fully-owned nodes
 *       die entirely and shared nodes survive — identity intact, alias
 *       strip per owner 2026-09-23), PLUS the carried-delta extraction:
 *       the rows actually leaving the origin are returned in append order.
 *       Coverage + checkpoint rows always move (extraction bookkeeping is
 *       session state, not graph content — same rule as deletion).
 *
 *   landChatTraces(graph, chatId, carried)
 *       append-only on the destination: nodes with a foreign origin id are
 *       re-minted `n_` and chains' endpoints follow the same map (the two
 *       graphs are independent namespaces — a verbatim id could weld this
 *       build's node onto an unrelated one already minted there); carried
 *       positions land for re-minted ids only (destination-owned ids keep
 *       their resting spot, owner copy+prune ruling 2026-10-29).
 *
 * The caller (src/server/workspaces.ts moveChatSessionGraph) owns the two
 * rewrites in ONE synchronous block, origin first then destination — the
 * wave-6 atomicity argument unchanged: no extraction append can interleave
 * while the event loop never yields mid-block; a crash between the two
 * writes leaves nothing resurrected (the moved session's coverage rows are
 * gone from both graphs, so re-extraction re-covers them against the
 * destination ledger — idempotent).
 */

/** The A3 dialog's two modes (docs/workspaces.md Fase 5): machine-checkable
 *  on the API as the required `mode` param — no default, so no accidental
 *  destructive choice. "move-session" rides moveChatSession (Phase 2). */
export type ChatMoveMode = "move-session" | "move-nodes";

/** One carried row of the move delta (append order preserved). */
export interface ChatTraceDelta {
	/** Node LINES whose provenance emptied in the origin — fully-owned
	 *  nodes (their create line, identity intact) or this session's own
	 *  link lines on shared nodes. Foreign provenance already stripped. */
	nodes: GraphNode[];
	/** Chain assertion lines with ALL their points removed (the moved
	 *  session was the only asserter). Premises/conclusion may name node
	 *  ids that died in the origin — `landChatTraces` re-mints them. */
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
	/** Resting positions of every carried id (node/chain), copied before
	 *  deletion pruned them from the origin's layout ledger. */
	positions: Record<string, Position>;
}

export interface ChatMoveStats {
	/** Node lines landed at the destination (create + link lines). */
	nodesMoved: number;
	/** Chain assertion lines landed. */
	chainsMoved: number;
	coverageMoved: number;
	checkpointsMoved: number;
	/** Distinct nodes that died ENTIRELY in the origin (all references were
	 *  this session's — owner ruling 2026-10-29: a moved trace leaving the
	 *  origin means the origin loses it, full death exactly like delete-nodes). */
	originNodesRemoved: number;
	/** Chain assertion lines removed from the origin (empty provenance or dead member). */
	originChainsRemoved: number;
}

const EMPTY_MOVE_STATS: ChatMoveStats = {
	nodesMoved: 0,
	chainsMoved: 0,
	coverageMoved: 0,
	checkpointsMoved: 0,
	originNodesRemoved: 0,
	originChainsRemoved: 0,
};

function movedGraphNodeId(): string {
	return `n_${randomBytes(6).toString("hex")}`;
}

const moveChainKey = (premises: readonly string[], conclusion: string): string =>
	`${[...premises].sort().join(",")} -> ${conclusion}`;

/**
 * The origin's TAKE side. Synchronous by design (the atomicity argument),
 * idempotent (a second take finds nothing and carries nothing).
 */
export function takeChatTraces(graphStore: GraphStore, chatId: string): {
	delta: ChatTraceDelta;
	stats: ChatMoveStats;
} {
	// Bookkeeping rides ALWAYS — extraction state is session state, not graph
	// content (the same rule as deletion, preserve-graph mode included).
	const allCoverage = graphStore.readCoverage();
	const movedCoverage = allCoverage.filter((row) => row.chatId === chatId);
	const keptCoverage = allCoverage.filter((row) => row.chatId !== chatId);
	const allCheckpoints = graphStore.readCheckpoints();
	const movedCheckpoints = allCheckpoints.filter((row) => row.chatId === chatId);
	const keptCheckpoints = allCheckpoints.filter((row) => row.chatId !== chatId);

	const nodeLines = graphStore.readNodes();
	const chainLines = graphStore.readChains();

	const touched =
		nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
		chainLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId));

	if (!touched) {
		if (movedCoverage.length > 0 || movedCheckpoints.length > 0) {
			graphStore.rewriteLedgers({ coverage: keptCoverage, checkpoints: keptCheckpoints });
		}
		return {
			delta: { nodes: [], chains: [], coverage: movedCoverage, checkpoints: movedCheckpoints, positions: {} },
			stats: {
				...EMPTY_MOVE_STATS,
				coverageMoved: movedCoverage.length,
				checkpointsMoved: movedCheckpoints.length,
			},
		};
	}

	// 1. Survival — identical rule to deleteChatTraces: a node lives iff ANY
	//    surviving reference remains (another chat/src's provenance point).
	const survives = (points: ReadonlyArray<{ chatId: string }>): boolean =>
		points.some((pt) => pt.chatId !== chatId);
	const live = new Set<string>();
	for (const line of nodeLines) {
		if (survives(line.provenance)) live.add(line.id);
	}

	// 2. Node lines — per-line, exactly the deletion's filter with the
	//    carried-delta extraction: every point of chatId is stripped from the
	//    origin; what leaves rides out in append order.
	const outNodes: GraphNode[] = [];
	const carriedNodes: GraphNode[] = [];
	const seenIds = new Set<string>();
	for (const line of nodeLines) {
		const first = !seenIds.has(line.id);
		seenIds.add(line.id);
		if (!live.has(line.id)) {
			// The whole node dies in the origin (owner ruling 2026-10-29 —
			// full death, exactly like delete-nodes): every line carries its
			// provenance out; the create line leads with its phrasings
			// (identity intact), link lines carry points only.
			carriedNodes.push({
				...line,
				provenance: line.provenance.filter((pt) => pt.chatId === chatId),
				aliases: first ? [...line.aliases] : [],
			});
			continue;
		}
		const movedPoints = line.provenance.filter((pt) => pt.chatId === chatId);
		if (movedPoints.length === 0) {
			outNodes.push(line); // untouched by this session
			continue;
		}
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		if (points.length > 0) {
			// A shared node: the session's points (and this run's phrasings)
			// ride out as their own carried line; the foreign points stay in
			// the origin with the line (mix-line case keeps the phrasings —
			// defensive: single runs never mix chats).
			outNodes.push({ ...line, provenance: points });
			carriedNodes.push({ ...line, provenance: movedPoints, aliases: [...line.aliases] });
			continue;
		}
		if (first) {
			// The create line of a surviving node the moved session minted —
			// identity stays in the origin (owner ruling 2026-09-23 re-read
			// for moves: all traces move, identity survives); this session's
			// phrasings carry out.
			outNodes.push({ ...line, provenance: [], aliases: [] });
			carriedNodes.push({ ...line, provenance: movedPoints, aliases: [...line.aliases] });
		} else {
			// The moved session's link line on a node another session
			// created: the whole line leaves (phrasings + points).
			carriedNodes.push({ ...line, provenance: movedPoints, aliases: [...line.aliases] });
		}
	}

	// 3. Chains — strip this session's points; an assertion DIES in the
	//    origin when this move empties its provenance or any member node
	//    died in this take (the deletion's deadNodes rule, unchanged). A
	//    dying line carries ALL its provenance out (survival needs no chain
	//    points — only node lines reference chains, which ride the origin's
	//    rewrite; carriedChains never feeds survival).
	const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
	const outChains: GraphChain[] = [];
	const carriedChains: GraphChain[] = [];
	for (const line of chainLines) {
		if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise))) {
			carriedChains.push({ ...line, provenance: line.provenance.filter((pt) => pt.chatId === chatId) });
			continue;
		}
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		if (line.provenance.length > 0 && points.length === 0) {
			carriedChains.push({ ...line, provenance: line.provenance });
			continue;
		}
		outChains.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
	}

	// 4. Carried positions — every carried id's resting spot (dead member
	//    nodes ride too), copied BEFORE the prune below.
	const carriedIds = new Set<string>([
		...carriedNodes.map((line) => line.id),
		...carriedChains.map((line) => line.id),
	]);
	for (const line of carriedChains) {
		if (deadNodes.has(line.conclusion)) carriedIds.add(line.conclusion);
		for (const premise of line.premises) if (deadNodes.has(premise)) carriedIds.add(premise);
	}

	// 5. The origin rewrite — nodes/chains always rewritten when the take
	//    touched them; coverage/checkpoints rewritten when non-empty.
	graphStore.rewriteLedgers({
		nodes: outNodes,
		chains: outChains,
		coverage: keptCoverage,
		checkpoints: keptCheckpoints,
	});

	// 6. Positions prune — dead ids (nodes + chains) leave the origin's
	//    layout ledger, same rule as deletion.
	const deadChainIds = new Set(
		chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id),
	);
	const knownNodeIds = new Set(nodeLines.map((line) => line.id));
	const positions = graphStore.readPositions();
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(
			([id]) => (live.has(id) || !knownNodeIds.has(id)) && !deadChainIds.has(id),
		),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	const carriedPositions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => carriedIds.has(id)),
	);

	return {
		delta: {
			nodes: carriedNodes,
			chains: carriedChains,
			coverage: movedCoverage,
			checkpoints: movedCheckpoints,
			positions: carriedPositions,
		},
		stats: {
			...EMPTY_MOVE_STATS,
			nodesMoved: carriedNodes.length,
			chainsMoved: carriedChains.length,
			coverageMoved: movedCoverage.length,
			checkpointsMoved: movedCheckpoints.length,
			originNodesRemoved: deadNodes.size,
			originChainsRemoved: chainLines.length - outChains.length,
		},
	};
}

/**
 * The destination's LAND side. APPEND-ONLY (appendNode/appendChain — the
 * destination store never rewrites its ledgers): carried node ids foreign
 * to the destination are re-minted `n_`, chains' endpoints follow the same
 * map, and a chain line already asserted by chatId keeps its destination
 * id and unions provenance link-style (the merger rule, preserved).
 */
export function landChatTraces(graphStore: GraphStore, chatId: string, delta: ChatTraceDelta): void {
	if (
		delta.nodes.length === 0 &&
		delta.chains.length === 0 &&
		delta.coverage.length === 0 &&
		delta.checkpoints.length === 0
	) {
		return;
	}

	// Node ids (owner ruling 2026-10-29): PRESERVED — each graph only ever
	// gained its ids here, so a carried id that the destination never minted
	// lands unchanged (deep-links and chain endpoints stay stable). On the
	// sole collision case (the destination holds that id from its own mint —
	// reachable only through a move round-trip) the line lands under a fresh
	// mint instead of welding onto the unrelated node.
	const destinationNodeIds = new Set(graphStore.readNodes().map((line) => line.id));
	const idMap = new Map<string, string>();
	for (const line of delta.nodes) {
		let target = idMap.get(line.id);
		if (target === undefined) {
			target = destinationNodeIds.has(line.id) ? movedGraphNodeId() : line.id;
			idMap.set(line.id, target);
		}
		graphStore.appendNode({ ...line, id: target });
	}

	const resolve = (endpoint: string): string => idMap.get(endpoint) ?? endpoint;
	// Link-style destination ids (the merger's rule, preserved): a carried
	// chain whose (premises, conclusion) key already lives at the destination
	// — asserted there by another source — keeps that destination id and
	// unions its provenance; otherwise the original arg_ id is preserved
	// (deep-stable), a real collision mints fresh.
	const destinationChainLines = graphStore.readChains();
	const existingChainIds = new Set(destinationChainLines.map((line) => line.id));
	const destinationKeys = new Map<string, string>();
	for (const line of destinationChainLines) {
		const key = moveChainKey(line.premises, line.conclusion);
		if (!destinationKeys.has(key)) destinationKeys.set(key, line.id);
	}
	for (const line of delta.chains) {
		const conclusion = resolve(line.conclusion);
		const premises = [...new Set(line.premises.map(resolve))].filter((p) => p !== conclusion);
		if (premises.length === 0) continue; // a dropped dead-member premise must not weld the conclusion alone
		const key = moveChainKey(premises, conclusion);
		const landedId = destinationKeys.get(key) ?? (existingChainIds.has(line.id) ? movedGraphChainId() : line.id);
		graphStore.appendChain({
			id: landedId,
			premises,
			conclusion,
			createdAt: line.createdAt,
			provenance: line.provenance,
		});
	}

	// Bookkeeping rides: coverage dedupes per (chatId, fp) against the
	// destination ledger (a moved-back session's rows stay one-fingered);
	// a checkpoint lands only when the destination has none for the chat yet
	// (the fold stamp the destination already carries is the newer truth).
	const heldCoverage = new Map<string, Set<string>>();
	for (const entry of graphStore.readCoverage()) {
		const keys = heldCoverage.get(entry.chatId) ?? new Set<string>();
		keys.add(entry.fp);
		heldCoverage.set(entry.chatId, keys);
	}
	for (const entry of delta.coverage) {
		if (heldCoverage.get(entry.chatId)?.has(entry.fp) === true) continue;
		graphStore.appendCoverage(entry);
		const keys = heldCoverage.get(entry.chatId) ?? new Set<string>();
		keys.add(entry.fp);
		heldCoverage.set(entry.chatId, keys);
	}
	if (!graphStore.readCheckpoints().some((row) => row.chatId === chatId)) {
		for (const checkpoint of delta.checkpoints) graphStore.appendCheckpoint(checkpoint);
	}

	// Carried positions land for their resolved ids — PRESERVED (unmapped) ids
	// ride their resting spot out unchanged, re-minted ids get the origin's
	// spot at the new id; a destination-owned id keeps its own resting spot
	// (owner copy+prune ruling 2026-10-29).
	if (Object.keys(delta.positions).length > 0) {
		const positions = graphStore.readPositions();
		let touched = false;
		for (const [oldId, position] of Object.entries(delta.positions)) {
			const target = idMap.has(oldId) ? idMap.get(oldId)! : oldId;
			if (target === undefined || positions[target] !== undefined) continue;
			positions[target] = position;
			touched = true;
		}
		if (touched) graphStore.writePositions(positions);
	}
}

function movedGraphChainId(): string {
	return `arg_${randomBytes(6).toString("hex")}`;
}
