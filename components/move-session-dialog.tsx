"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { UNSORTED_KEY } from "@/src/core";
import type { ChatListItem, ChatMoveMode, WorkspaceListItem } from "@/src/core";

/** The A3 checkbox copy (Phase 5, owner ruling 2026-10-29: mirror the
 *  delete dialog's TRACES_COPY shape). Exported pure for render pins —
 *  the copy is design, not implementation. */
export const MOVE_TRACES_COPY = {
	testid: "move-traces",
	checkbox: "move-traces-checkbox",
	title: "Also move its graph traces",
	body: "This session’s topics, links, and extraction records leave the origin graph too. Topics other sessions or imported notes also cover stay there; topics only this session created move entirely.",
};

/**
 * Move a session between workspaces (workspace wave Phase 3 + Phase 5,
 * owner A3 decision 2026-10-28, docs/workspaces.md) — the delete dialog's
 * shape (the two must read as one design): title "Move session?" + the
 * session name, the destination picker (every workspace except the current
 * one + Unsorted), the traces checkbox (unchecked = move-session-only;
 * checked = move-session-and-nodes, disabled for an Unsorted destination —
 * no graph there, decision 9), Cancel + the commit button.
 *
 * Retryable failures render honestly with a Try-again (the delete
 * dialog's law): 409 turn_in_flight / extraction_running clear on their
 * own; the server's error line shows verbatim.
 */
export function MoveSessionDialog({
	chat,
	workspaces,
	onClose,
	onMoved,
}: {
	/** The session up for moving; null = closed. */
	chat: Pick<ChatListItem, "id" | "title" | "workspaceId"> | null;
	/** The destinations — the sidebar filters out the current workspace. */
	workspaces: WorkspaceListItem[];
	onClose: () => void;
	/** Success path — the sidebar patches its snapshot; `revisions` carries
	 *  both stamps when the move actually transported graph traces (the
	 *  scoped lh:graph-revision announce is the sidebar's job). Phase 6:
	 *  each stamp names the graph directory it was read from — a workspace
	 *  id, or null for the legacy global graph. */
	onMoved: (
		id: string,
		workspaceId: string | null,
		revisions?: { origin: number; originScope: string | null; destination: number; destinationScope: string | null },
	) => void;
}) {
	const [target, setTarget] = useState<string>(UNSORTED_KEY);
	// The A3 checkbox (Phase 5): mirrors the delete dialog's traces
	// checkbox — unchecked by default (move-session-only). Disabled for an
	// Unsorted destination (no graph destination there, decision 9); a
	// selection change clears it honestly.
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	// Fresh state per session: closing resets, opening another chat starts clean.
	useEffect(() => {
		if (!chat) {
			setTarget(UNSORTED_KEY);
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [chat]);

	// Esc closes (claimed — the one-Esc law: a dialog Esc must not also
	// abort a turn or fold the sidebar).
	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chat, onClose]);

	const run = async () => {
		if (!chat || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const mode: ChatMoveMode = traces && target !== UNSORTED_KEY ? "move-nodes" : "move-session";
			const res = await fetch(`/api/chats/${chat.id}/workspace?mode=${mode}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ workspaceId: target === UNSORTED_KEY ? null : target }),
			});
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				workspaceId?: string | null;
				originGraphRevision?: number | null;
				originScope?: string | null;
				destinationGraphRevision?: number | null;
				destinationScope?: string | null;
			};
			if (!res.ok) {
				// 409 (turn/extraction running) is retryable — keep the dialog
				// open, show the server's line (Try-again = Move pressed again).
				setFailure({ code: body.code ?? "error", error: body.error ?? `Move failed (${res.status})` });
				setBusy(false);
				return;
			}
			const revision =
				typeof body.originGraphRevision === "number" && typeof body.destinationGraphRevision === "number"
					? {
							origin: body.originGraphRevision,
							// Phase 6 scope pinning: the server names each stamp's
							// graph directory (null = legacy global). The chat's
							// pre-move filing is the origin fallback — null for an
							// unsorted session (its traces rode the legacy graph).
							originScope: body.originScope ?? chat.workspaceId ?? null,
							destinationScope: body.destinationScope ?? (target === UNSORTED_KEY ? null : target),
							destination: body.destinationGraphRevision,
					  }
					: undefined;
			onMoved(chat.id, body.workspaceId ?? null, revision);
		} catch {
			setFailure({ code: "network", error: "Move failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!chat) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<MoveSessionBody
				chat={chat}
				workspaces={workspaces}
				target={target}
				traces={traces}
				busy={busy}
				failure={failure}
				onTarget={(next) => {
					if (next === UNSORTED_KEY) setTraces(false);
					setTarget(next);
				}}
				onTraces={setTraces}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins (the delete-dialog
 *  pattern). The wrapper owns state + effects + portal. */
export function MoveSessionBody({
	chat,
	workspaces,
	target,
	traces,
	busy,
	failure,
	onTarget,
	onTraces,
	onClose,
	onRun,
}: {
	chat: Pick<ChatListItem, "id" | "title" | "workspaceId">;
	workspaces: WorkspaceListItem[];
	target: string;
	/** The A3 traces checkbox — unchecked by default (move-session-only),
	 *  disabled for an Unsorted destination (no graph there, decision 9). */
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTarget: (key: string) => void;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			data-testid="move-session-dialog"
			className="w-[min(26rem,90vw)] rounded-xl border bg-card p-4 shadow-xl"
			role="dialog"
			aria-modal="true"
			aria-label="Move session"
		>
			<h2 className="font-ui text-sm font-semibold">Move session?</h2>
			<p className="mt-1 font-ui text-sm text-muted-foreground">{chat.title}</p>

			<div className="mt-3 flex flex-col gap-1" data-testid="move-destinations">
				{workspaces.map((w) => (
					<button
						key={w.id}
						type="button"
						data-testid={`move-destination-${w.id}`}
						disabled={busy}
						onClick={() => onTarget(w.id)}
						className={
							"flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent " +
							(target === w.id ? "bg-accent text-foreground" : "text-muted-foreground")
						}
					>
						<span className="min-w-0 truncate">{w.name}</span>
						<span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
							{w.sessionCount} {w.sessionCount === 1 ? "session" : "sessions"}
						</span>
					</button>
				))}
				<button
					type="button"
					data-testid={`move-destination-${UNSORTED_KEY}`}
					disabled={busy}
					onClick={() => onTarget(UNSORTED_KEY)}
					className={
						"flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent " +
						(target === UNSORTED_KEY ? "bg-accent text-foreground" : "text-muted-foreground")
					}
				>
					<span>Unsorted</span>
					<span className="ml-2 shrink-0 text-[11px] text-muted-foreground/70">no workspace</span>
				</button>
			</div>
		{/* The A3 traces checkbox (Phase 5): the delete dialog's shape —
		    unchecked by default. The checkbox is ALWAYS the same control,
		    disabled for an Unsorted destination (no graph destination there,
		    decision 9) with a short honest line in its place. */}
		<label
			data-testid={MOVE_TRACES_COPY.testid}
			className={
				"mt-3 flex items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3" +
				(target === UNSORTED_KEY ? " opacity-60" : " cursor-pointer")
			}
		>
			<input
				type="checkbox"
				data-testid={MOVE_TRACES_COPY.checkbox}
				checked={target === UNSORTED_KEY ? false : traces}
				onChange={(e) => onTraces(e.target.checked)}
				disabled={busy || target === UNSORTED_KEY}
				className="mt-0.5 size-4 shrink-0 accent-primary"
			/>
			<span className="min-w-0">
				<span className="block text-sm text-foreground">{MOVE_TRACES_COPY.title}</span>
				{target === UNSORTED_KEY ? (
					<span data-testid="move-traces-unsorted" className="mt-1 block text-xs text-muted-foreground">
						Unsorted has no graph — the traces stay where they are.
					</span>
				) : (
					<span className="mt-1 block text-xs text-muted-foreground">{MOVE_TRACES_COPY.body}</span>
				)}
			</span>
		</label>
			{failure && (
				<p role="alert" className="mt-3 text-sm text-destructive">
					{failure.error}
				</p>
			)}

			<div className="mt-4 flex items-center justify-end gap-2">
				<button
					type="button"
					data-testid="move-cancel"
					disabled={busy}
					onClick={onClose}
					className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="move-commit"
					disabled={busy}
					onClick={onRun}
					className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
				>
					{busy ? "Moving…" : "Move"}
				</button>
			</div>
		</div>
	);
}
