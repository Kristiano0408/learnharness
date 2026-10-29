"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DumbbellIcon, FolderIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { UNSORTED_KEY } from "@/src/core";
import type { WorkspaceListItem } from "@/src/core";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, setup }: { picker?: ReactNode; setup?: ReactNode }) {
	if (!picker && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}

/**
 * The draft's workspace chip (workspace wave Phase 3, owner decision 3C):
 * the filing choice rides the draft — the created session carries
 * workspaceId on the POST body. The chip names the current filing
 * (default: the last picked workspace, persisted by the caller; absent =
 * Unsorted); clicking opens the destination menu (every workspace +
 * Unsorted). MenuShell owns placement (the composer sits at the screen
 * bottom — the menu opens UP, the model menus' pattern).
 */
export function WorkspaceChip({
	workspaces,
	value,
	onChange,
}: {
	workspaces: WorkspaceListItem[];
	/** The current filing: a workspace id, or UNSORTED_KEY. */
	value: string;
	onChange: (key: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const name = value === UNSORTED_KEY ? "Unsorted" : workspaces.find((w) => w.id === value)?.name ?? "Unsorted";
	// The menu's dismissal contract (the sidebar context menu's shape):
	// any pointerdown outside closes; Esc is claimed (the one-Esc law).
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	return (
		<div className="relative">
			<button
				ref={anchorRef}
				type="button"
				data-testid="workspace-chip"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(value === UNSORTED_KEY
						? "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
						: "border-border bg-card text-foreground hover:bg-accent")
				}
			>
				<FolderIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{value === UNSORTED_KEY ? "Workspace: Unsorted" : name}
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="workspace-chip-menu"
					preferredSide="up"
					align="left"
					menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{workspaces.map((w) => (
						<button
							key={w.id}
							type="button"
							data-testid={`workspace-chip-option-${w.id}`}
							onClick={() => {
								onChange(w.id);
								setOpen(false);
							}}
							className={
								"flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent " +
								(value === w.id ? "bg-accent text-foreground" : "text-muted-foreground")
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
						data-testid={`workspace-chip-option-${UNSORTED_KEY}`}
						onClick={() => {
							onChange(UNSORTED_KEY);
							setOpen(false);
						}}
						className={
							"flex items-center rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent " +
							(value === UNSORTED_KEY ? "bg-accent text-foreground" : "text-muted-foreground")
						}
					>
						Unsorted
					</button>
				</MenuShell>
			)}
		</div>
	);
}
