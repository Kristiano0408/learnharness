"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { MoveSessionDialog } from "@/components/move-session-dialog";
import type { ChatDeleteMode } from "@/src/core";
import {
	ChevronRightIcon,
	DumbbellIcon,
	FolderPlusIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	Trash2Icon,
} from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fuzzyScore } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";
import { kbdEventForAction } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

/**
 * Toggleable sidebar — NOT a modal drawer: no backdrop, no focus theft. It
 * sits inline next to the content and can stay open while working in a
 * session. Open state persists across pages (provider lives in the root
 * layout) and across reloads (localStorage).
 */

const STORAGE_KEY = "lh:sidebar-open";

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * sidebar would squeeze the page below the 640px window floor (the two
 * numbers compose: 640 + 288 sidebar = 928), so it auto-closes — and
 * auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.lh.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";
const SIDEBAR_AUTOCLOSE = 928;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		lh?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			/** External Next desktop-dev uses the server's web connections. */
			subscriptionTransport?: "desktop" | "web";
			openSubscriptionBrowser?: (action: string) => Promise<void>;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			expandWindow: () => void;
			/** The zoom truth (owner round 7): subscribes to "lh:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			onOpenSettings?: (cb: (section: string) => void) => () => void;
		};
	}
}

const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys"); // cover changes missed before this root-lifetime subscription
		return off;
	}, []);
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpen] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .lh-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("lh-electron");
			document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
		}

		// THE ZOOM TRUTH (owner round 7, 2026-10-05): ⌘±/⌘0 zoom the UI
		// (Electron zoomFactor) while the native traffic lights stay
		// physical-fixed — the CSS gutter lengths divide by this factor so
		// their RENDERED size never moves. getZoom covers the first-paint
		// race; every later change arrives as an lh:zoom push.
		const setZoomVar = (factor: number) =>
			document.documentElement.style.setProperty("--lh-zoom", String(factor));
		const off = window.lh?.onZoom?.(setZoomVar);
		void window.lh?.getZoom?.().then(setZoomVar);

		const stored = localStorage.getItem(STORAGE_KEY);
		// Default: open (first run introduces the sidebar).
		setOpen(stored === null ? true : stored === "1");
		setMounted(true);
		return () => off?.();
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		// Opening while narrow (auto-closed, or the user's own closed-at-
		// narrow): ask the shell to widen to the threshold — the resize
		// listener flips `narrow` and the sidebar appears. The preference
		// persists like any other open, so a restart at a narrow width
		// still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(STORAGE_KEY, "0");
			setOpen(true);
			window.lh?.expandWindow();
			return;
		}
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, [narrow, open]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "lh:toggle-sidebar" while the dispatcher sent
	// "lh:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion lh-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-9 mr-0 lh-closed-toggle",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
function sessionMeta(chat: ChatListItem): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt)}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) {
		return `Problem waiting · ${timeAgo(chat.updatedAt)}`;
	}
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			<SessionStatus busy={chat.busy || chat.compacting} />
			<span className="min-w-0 flex-1">
				{/* Titles are the learner's/teacher's WORDS — Source Sans 3, the
				    same voice the words were typed in (every input is lh-prose);
				    the meta line below stays JetBrains Mono (machine data). One
				    rule, finally applied to the picker too (owner, typography
				    round): mono = chrome, Source Sans = human words. */}
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
				<span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
			{/* The dumbbell rides the FAR RIGHT (owner round 6, 2026-10-05) —
			    was left of the name; right-aligned keeps the titles flush with
			    the teaching rows and reads cleaner. */}
			{(chat.kind ?? "teach") === "practice" && (
				<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Practice session" />
			)}
		</button>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-2"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</div>
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter, persisted in
 *  localStorage. Workspace wave Phase 3 (owner decision 4C, 2026-10-28):
 *  the filter is PER WORKSPACE — the persisted value is a sectionKey →
 *  filter map (the "*" default entry + per-section overrides; the legacy
 *  bare string migrates lazily on read). The fold + map helpers live in
 *  core (workspace-groups.ts); the type re-exports from there. */
export type { SessionKindFilter } from "@/src/core";
import {
	FILTER_DEFAULT_KEY,
	UNSORTED_KEY,
	filterChatsByKind,
	groupChatsByWorkspace,
	kindFilterFor,
	readKindFilters,
	withKindFilter,
	writeKindFilters,
	type SessionKindFilter,
	type WorkspaceListItem,
} from "@/src/core";
const KIND_FILTER_KEY = "lh:session-kind-filter";
/** Collapsed workspace sections (id → true). Unsorted is never collapsed
 *  (it is the fallback home, not a workspace the learner curated). */
const COLLAPSED_KEY = "lh:workspace-collapsed";

/** The per-section kind-filter row (Teaching / Practice / All — the same
 *  three-way design as the pre-workspace global row, scoped to one
 *  section). Only rendered when the section is open. */
export function KindFilterRow({ sectionKey, filter, onFilter }: { sectionKey: string; filter: SessionKindFilter; onFilter: (f: SessionKindFilter) => void }) {
	return (
		<div className="mx-3 mt-1 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid={`kind-filter-${sectionKey}`}>
			{(["teach", "practice", "all"] as const).map((f) => (
				<button
					key={f}
					type="button"
					data-testid={`kind-filter-${sectionKey}-${f}`}
					onClick={() => onFilter(f)}
					className={cn(
						"flex-1 rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors",
						filter === f
							? "bg-accent text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{f === "teach" ? "Teaching" : f === "all" ? "All" : "Practice"}
				</button>
			))}
		</div>
	);
}

/** The workspace section header: caret (collapse), name (click-to-rename
 *  inline, the RenameRow's rules), the busy spinner (a section owns a
 *  running turn), session count. The Unsorted section carries no rename/
 *  delete — it is a fallback grouping, not a record. */
export function WorkspaceSectionHeader({
	section,
	collapsed,
	busyCount,
	onToggle,
	onRename,
	onDelete,
}: {
	section: { key: string; name: string; workspaceId: string | null; chats: { length: number } };
	collapsed: boolean;
	busyCount: number;
	onToggle: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const isUnsorted = section.workspaceId === null;
	return (
		<div className="group/section mt-1.5 flex items-center gap-1 px-2" data-testid={`workspace-section-${section.key}`}>
			<button
				type="button"
				data-testid={`workspace-collapse-${section.key}`}
				onClick={onToggle}
				aria-expanded={!collapsed}
				aria-label={collapsed ? `Expand ${section.name}` : `Collapse ${section.name}`}
				className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<ChevronRightIcon className={cn("size-3.5 transition-transform duration-150", !collapsed && "rotate-90")} />
			</button>
			<button
				type="button"
				data-testid={`workspace-name-${section.key}`}
				onClick={onRename}
				className="min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left font-prose text-(length:--lh-prose-size) text-foreground transition-colors hover:bg-accent"
			>
				{section.name}
			</button>
			{busyCount > 0 && <BrailleSpinner />}
			{section.chats.length > 0 && (
				<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{section.chats.length}</span>
			)}
			{!isUnsorted && (
				<span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/section:opacity-100">
					<button
						type="button"
						data-testid={`workspace-rename-${section.key}`}
						onClick={onRename}
						aria-label={`Rename workspace ${section.name}`}
						className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PencilIcon className="size-3" />
					</button>
					<button
						type="button"
						data-testid={`workspace-delete-${section.key}`}
						onClick={onDelete}
						aria-label={`Delete workspace ${section.name}`}
						className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<Trash2Icon className="size-3" />
					</button>
				</span>
			)}
		</div>
	);
}

/** The inline workspace-rename row (the RenameRow's rules: select-all
 *  entry, Enter/blur commits, Esc discards, empty commit discards). */
export function WorkspaceRenameRow({ name, onCommit, onCancel }: { name: string; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(name);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div data-testid="workspace-rename-row" className="mt-1.5 flex w-full items-center rounded-lg bg-accent px-2 py-1.5">
			<input
				ref={inputRef}
				value={draft}
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => onCommit(draft)}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						e.stopPropagation(); // discard, not also the sidebar/chat chains
						onCancel();
					}
				}}
				aria-label="Rename workspace"
				data-testid="workspace-rename-input"
				className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-1 text-foreground outline-none"
			/>
		</div>
	);
}

/** The tiny delete confirmation (the danger-fence law: destructive last,
 *  explicit, no silent cascade — the server's 409 not_empty is the belt). */
export function WorkspaceDeleteConfirm({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
	return (
		<div data-testid="workspace-delete-confirm" className="mt-1.5 flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2 py-1.5 text-xs">
			<span className="min-w-0 flex-1 truncate text-muted-foreground">Delete workspace “{name}”?</span>
			<button type="button" data-testid="workspace-delete-cancel" onClick={onCancel} className="rounded-sm px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				Cancel
			</button>
			<button type="button" data-testid="workspace-delete-confirm-button" onClick={onConfirm} className="rounded-sm px-2 py-1 text-destructive transition-colors hover:bg-accent">
				Delete
			</button>
		</div>
	);
}

/** The inline "+ New workspace" row (the RenameRow's geometry — the name
 *  is the whole form; Enter creates, Esc discards, empty discards). */
export function NewWorkspaceRow({ onCommit, onCancel }: { onCommit: (name: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	return (
		<div data-testid="new-workspace-row" className="mx-3 mt-1.5 flex items-center gap-1 rounded-lg border border-border/60 bg-background px-2 py-1.5">
			<input
				ref={inputRef}
				value={draft}
				spellCheck={false}
				placeholder="Workspace name"
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						const t = draft.trim();
						if (t) onCommit(t);
					}
					if (e.key === "Escape") {
						e.stopPropagation(); // the one-Esc law: not the window chain
						onCancel();
					}
				}}
				aria-label="New workspace name"
				data-testid="new-workspace-input"
				className="lh-input w-full min-w-0 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
			/>
		</div>
	);
}

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
	const [query, setQuery] = useState("");
	const [kindFilters, setKindFilters] = useState<Record<string, SessionKindFilter>>({});
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [creatingWorkspace, setCreatingWorkspace] = useState(false);
	const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
	const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
	const [movingChat, setMovingChat] = useState<ChatListItem | null>(null);
	useEffect(() => {
		setKindFilters(readKindFilters(window.localStorage.getItem(KIND_FILTER_KEY)));
		try {
			const raw = window.localStorage.getItem(COLLAPSED_KEY);
			const parsed: unknown = raw === null ? {} : JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const out: Record<string, boolean> = {};
				for (const [key, value] of Object.entries(parsed)) if (value === true) out[key] = true;
				setCollapsed(out);
			}
		} catch {
			/* corrupt → nothing collapsed */
		}
	}, []);
	const setFilter = useCallback((sectionKey: string, f: SessionKindFilter) => {
		setKindFilters((prev) => {
			const next = withKindFilter(prev, sectionKey, f);
			window.localStorage.setItem(KIND_FILTER_KEY, writeKindFilters(next));
			return next;
		});
	}, []);
	const toggleCollapsed = useCallback((sectionKey: string) => {
		setCollapsed((prev) => {
			const next = { ...prev };
			if (next[sectionKey]) delete next[sectionKey];
			else next[sectionKey] = true;
			window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
			return next;
		});
	}, []);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Workspace wave
	   Phase 3: the draft carries the filing chip (default = the last
	   picked workspace, localStorage; absent = Unsorted). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. Empty query
	 * keeps the natural list order (scores are all 0, sort is stable).
	 * Workspace wave (decision 4C): the kind filter is PER SECTION; a live
	 * query FLATTENS the sections (the query wins over the structure —
	 * the quick-open pattern stays one flat walked list). */
	const sections = useMemo(
		() => (chats === null ? null : groupChatsByWorkspace(chats, workspaces)),
		[chats, workspaces],
	);
	const flat = useMemo(() => {
		if (chats === null) return null;
		const q = query.trim();
		if (!q) return null;
		return chats
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	}, [chats, query]);
	/* The render truth in one value: a live query FLATTENS the sections
	 * (the query wins over the structure — the quick-open walk stays one
	 * flat list); no query renders the workspace sections. `shown` feeds
	 * the empty-state copy and the walk's row count — it mirrors the
	 * RENDERED row order (collapsed sections hold no rows). */
	const shown: ChatListItem[] | null =
		flat ??
		(sections
			? sections.flatMap((s) => (collapsed[s.key] === true ? [] : filterChatsByKind(s.chats, kindFilterFor(kindFilters, s.key))))
			: null);

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			// The workspace list rides the same refresh (the sections need
			// both snapshots; workspaces-changed pokes the same fetch).
			const [chatsRes, workspacesRes] = await Promise.all([
				fetch("/api/chats", { cache: "no-store" }),
				fetch("/api/workspaces", { cache: "no-store" }),
			]);
			const d = (await chatsRes.json()) as { chats: ChatListItem[] };
			const w = (await workspacesRes.json()) as { workspaces: WorkspaceListItem[] };
			setChats(d.chats);
			setWorkspaces(w.workspaces);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. lh:turn-state +
	   lh:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("workspaces-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE SEARCH OWNS THE
	   WALK: ↑/↓ cycle the filtered list (wrap — "cycle"), Enter opens the
	   walked row, or the FIRST match when nothing is walked (owner,
	   2026-10-10 — the quick-open pattern: ⌘⇧F, type, Enter, done). The
	   Alt+↑/↓/↵ global cycle was RETIRED the same round: barely used,
	   felt laggy. The selection is a row index into `shown`, so the walk
	   follows whatever the query + kind filter leave. Mouse and keyboard
	   coexist: hovering doesn't claim, a click or an open clears the
	   selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxChatId(chat.id);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxChatId(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxChatId]);

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then lh:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles), and announce the graph
	// revision so the graph view refetches (deletion is the one writer
	// the status poll can't see — no run ever transitions some→none).
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision, scope: null } }));
		},
		[pathname, router],
	);

	/* ── Workspace management (Phase 3): create / rename / delete + the
	    session move. Every mutation rides the events channel too (the
	    store announces) — the local patch is the same-tab instant, the
	    debounced refresh is the backstop. ── */
	const createWorkspace = useCallback(async (name: string) => {
		setCreatingWorkspace(false);
		try {
			const res = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			if (!res.ok) return; // the shape gate already refused honestly
			const created = (await res.json()) as { id: string; name: string };
			const now = new Date().toISOString();
			setWorkspaces((prev) => [...prev, { ...created, createdAt: now, updatedAt: now, sessionCount: 0, busyCount: 0 }]);
			void refresh();
		} catch (err) {
			console.error("workspace create failed:", err);
		}
	}, [refresh]);

	const commitWorkspaceRename = useCallback(async (id: string, next: string) => {
		setRenamingWorkspaceId(null);
		const t = next.trim();
		if (t === "") return; // empty commit discards (the header rename's rule)
		try {
			const res = await fetch(`/api/workspaces/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: t }),
			});
			if (!res.ok) throw new Error(`workspace rename failed: ${res.status}`);
			setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name: t } : w)));
		} catch (err) {
			console.error("workspace rename failed:", err); // keep the old name
		}
	}, []);

	const deleteWorkspaceConfirmed = useCallback(async (id: string) => {
		setDeletingWorkspaceId(null);
		try {
			const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
			if (res.status === 409) {
				// The server's honest refusal (not_empty) — the sessions stay;
				// the learner moves or deletes them first (no silent cascade).
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				window.alert(body.error ?? "Move or delete this workspace's sessions first.");
				void refresh();
				return;
			}
			if (!res.ok) throw new Error(`workspace delete failed: ${res.status}`);
			// Its sessions orphan to Unsorted (the fold reads an unknown
			// workspaceId as Unsorted — the refresh lands the truth).
			setWorkspaces((prev) => prev.filter((w) => w.id !== id));
			void refresh();
		} catch (err) {
			console.error("workspace delete failed:", err);
		}
	}, [refresh]);

	// Move success (the dialog's commit): patch the filing in place — the
	// section fold re-groups on the next render; the server announced
	// chats-changed, the debounced refresh is the backstop.
	const onMoved = useCallback(
		(id: string, workspaceId: string | null, revisions?: { origin: number; originScope: string | null; destination: number; destinationScope: string | null }) => {
			setMovingChat(null);
			setChats((prev) =>
				prev
					? prev.map((c) => (c.id === id ? { ...c, ...(workspaceId === null ? { workspaceId: undefined } : { workspaceId }) } : c))
					: prev,
			);
			// A move-nodes transport rewrote BOTH graphs: announce each stamp
			// scoped to the graph it was read from (Phase 6). The Phase 5
			// legacy-scope pin stays honored: an UNSCOPED stamp still reaches
			// every selectorless view; a scope-less ORIGIN rides with it as a
			// legacy fallback when the server didn't name its scope.
			if (revisions) {
				window.dispatchEvent(
					new CustomEvent("lh:graph-revision", {
						detail: { revision: revisions.origin, ...(revisions.originScope === undefined ? {} : { scope: revisions.originScope }) },
					}),
				);
				window.dispatchEvent(
					new CustomEvent("lh:graph-revision", {
						detail: { revision: revisions.destination, scope: revisions.destinationScope ?? undefined },
					}),
				);
			}
		},
		[],
	);

	useEffect(() => {
		const onFocusSearch = () => {
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => searchRef.current?.focus());
		};
		window.addEventListener("lh:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("lh:kbd-sessions-search", onFocusSearch);
	}, [open, toggle]);

	// Keep the kbd-selected row in view. In the flattened query list the
	// rows are the container's only buttons (the index matches); in the
	// section view the headers/filters add buttons before the rows, so the
	// walk pins by the row's own testid attribute instead.
	useEffect(() => {
		if (kbdIndex === null) return;
		const container = listRef.current;
		if (!container) return;
		if (flat) {
			container.querySelectorAll("button")[kbdIndex]?.scrollIntoView({ block: "nearest" });
			return;
		}
		const rows = container.querySelectorAll('[data-testid="session-row"]');
		const target = rows[kbdIndex] ?? rows[rows.length - 1];
		target?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex, flat]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0")}
			aria-hidden={!open}
		>
			<div className="flex h-full w-72 flex-col border-r bg-background">
				{/* LH wordmark — the owner's header; close toggle sits at the edge.
				    Merged chrome (2026-09-17): in Electron this band is the
				    window's drag surface and starts after the traffic lights
				    (.lh-lights-gutter); in the browser those classes are inert. */}
				<div className="lh-drag lh-lights-gutter flex items-center justify-between px-4 py-3">
					{/* The owner's mark (2026-09-17) replaces the "LH" text — still the
					    home link, still vertically centered by the band's items-center.
					    The 92px .lh-lights-gutter keeps it clear of the traffic lights
					    with the lights' own edge-inset as the gap. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Hint
						// Kept (owner, subtlety round 2026-09-25) but to the RIGHT
						// of the logo, carrying its real shortcut: ⌘G jumps to
						// the graph view (keyboard-shortcuts routes it to "/",
						// the same destination as this logo).
						label="Home"
						action="jump-graph"
						side="right"
					>
						<Link
							href="/"
							aria-label="Home"
							className="lh-no-drag flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
						>
							<LhMark className="size-6" />
						</Link>
					</Hint>
					<Hint label="Close sidebar" action="toggle-sidebar">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							onClick={toggle}
							className="lh-no-drag"
						>
							<PanelLeftCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>

				{/* Two doors, STACKED (owner round 8, 2026-10-05 — was a
				    half/half row): full-width rows read cleaner and give the
				    labels room; teaching keeps the original draft route,
				    practice carries its mode. */}
				<div className="mx-3 mb-2 flex flex-col gap-1.5">
					<button
						type="button"
						data-testid="new-session"
						onClick={() => void newSession()}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						Teaching
						<span className="sr-only">create a new teaching session</span>
					</button>
					<button
						type="button"
						data-testid="new-session-practice"
						onClick={() => router.push("/chat/new?mode=practice")}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DumbbellIcon className="size-3" />
						Practice
						<span className="sr-only">create a new practice session</span>
					</button>
					{/* Workspace wave Phase 3 (decision 3C): the sidebar's door —
					    inline name row, Enter creates (the rename row's rules). */}
					<button
						type="button"
						data-testid="new-workspace"
						onClick={() => setCreatingWorkspace(true)}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<FolderPlusIcon className="size-3" />
						New workspace
						<span className="sr-only">create a new workspace</span>
					</button>
				</div>
				{creatingWorkspace && <NewWorkspaceRow onCommit={(name) => void createWorkspace(name)} onCancel={() => setCreatingWorkspace(false)} />}

				<div className="mx-3 mb-2 flex items-center gap-2">
					<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
					<Hint label="Search sessions" action="sessions-search" side="bottom">
					<span className="relative flex-1">
						<Input
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								// The list reorders under the query every keystroke —
								// a stale walk index would point at the wrong row.
								setKbdIndex(null);
							}}
							// THE SEARCH OWNS THE WALK (owner, 2026-10-10 — the
							// retired Alt+↑/↓/↵ cycle's successor): ↑/↓ cycle the
							// filtered rows (wrap), Enter opens the walked row —
							// or the FIRST match when nothing is walked (the
							// quick-open pattern) — then blurs (focus returns to
							// the app per the Enter law; the query stays for
							// re-searching). Esc leaves the search (owner,
							// keyboard wave): blur back to normal, and claim the
							// key so the window Esc chain (dictation / abort)
							// doesn't also fire.
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									e.currentTarget.blur();
									return;
								}
								// Modified keys belong to the surface (⇧↵ etc.).
								if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
								const n = shown?.length ?? 0;
								if (n === 0) return;
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									// The rows move, not the caret.
									e.preventDefault();
									const dir = e.key === "ArrowDown" ? 1 : -1;
									setKbdIndex((i) =>
										i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n,
										);
									return;
								}
								if (e.key === "Enter") {
									const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
									if (!target) return;
									e.preventDefault();
									router.push(`/chat/${target.id}`);
									setKbdIndex(null);
									e.currentTarget.blur();
								}
							}}
							placeholder="Search…"
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
					</Hint>
				</div>

				{/* The kind filter is PER WORKSPACE (owner decision 4C, workspace
				    wave Phase 3): the row moved from a single global caption into
				    each section (rendered per open section, below). A live query
				    flattens the sections — the filter row hides with the sections
				    (the query scopes the whole list, structure retired for the
				    walk). */}

				<div ref={listRef} className="flex-1 overflow-y-auto p-2" data-testid="session-list">
					{shown === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : flat !== null ? (
						/* The flattened query list — one walked list, no sections,
						   no per-section filter rows (the query scopes everything). */
						flat.length === 0 ? (
							<div className="px-2 py-4 text-xs text-muted-foreground">No sessions match.</div>
						) : (
							flat.map((c, i) =>
								renamingId === c.id ? (
									<RenameRow
										key={c.id}
										chat={c}
										onCommit={(next) => void commitRename(c.id, next)}
										onCancel={() => setRenamingId(null)}
									/>
								) : (
									<SessionRow
										key={c.id}
										chat={c}
										active={pathname === `/chat/${c.id}`}
										kbdSelected={i === kbdIndex}
										onOpen={() => {
											setKbdIndex(null);
											router.push(`/chat/${c.id}`);
										}}
										onContextMenu={(e) => openContext(e, c)}
									/>
								),
							)
						)
					) : sections!.length === 0 ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">No sessions yet.</div>
					) : (
						/* The walk cursor runs across the sections in render order;
						   `shown` mirrors the same sequence (collapsed sections hold
						   no rows). */
						(() => {
							let walkCursor = 0;
							return (
						sections!.map((section) => {
							const filter = kindFilterFor(kindFilters, section.key);
							const visible = filterChatsByKind(section.chats, filter);
							const isCollapsed = collapsed[section.key] === true;
							// busyCount from the section's own rows — ChatListItem.busy
							// is the route's liveness merge (the same spinner the rows
							// carry; the header signals "a section owns a live turn").
							const busyCount = section.chats.filter((c) => c.busy).length;
							return (
								<div key={section.key}>
									{renamingWorkspaceId === section.key ? (
										<WorkspaceRenameRow
											name={section.name}
											onCommit={(next) => void commitWorkspaceRename(section.key, next)}
											onCancel={() => setRenamingWorkspaceId(null)}
										/>
									) : (
										<WorkspaceSectionHeader
											section={section}
											collapsed={isCollapsed}
											busyCount={busyCount}
											onToggle={() => toggleCollapsed(section.key)}
											onRename={() => section.workspaceId !== null && setRenamingWorkspaceId(section.key)}
											onDelete={() => section.workspaceId !== null && setDeletingWorkspaceId(section.key)}
										/>
									)}
									{deletingWorkspaceId === section.key && section.workspaceId !== null && (
										<WorkspaceDeleteConfirm
											name={section.name}
											onConfirm={() => void deleteWorkspaceConfirmed(section.workspaceId!)}
											onCancel={() => setDeletingWorkspaceId(null)}
										/>
									)}
									{!isCollapsed && (
										<>
											{/* The filter row rides any section holding
											    sessions — even when the current filter
											    empties it (the row must stay reachable
											    to switch back). */}
											{section.chats.length > 0 && (
												<KindFilterRow sectionKey={section.key} filter={filter} onFilter={(f) => setFilter(section.key, f)} />
											)}
											{visible.map((c) => {
												// The walk index runs across the sections in
												// render order — `shown` mirrors exactly this
												// sequence, so kbdIndex names the same row here.
												const walkIndex = walkCursor++;
												return renamingId === c.id ? (
													<div key={c.id} className="pl-3">
														<RenameRow
															chat={c}
															onCommit={(next) => void commitRename(c.id, next)}
															onCancel={() => setRenamingId(null)}
														/>
													</div>
												) : (
													<div key={c.id} className="pl-3">
														<SessionRow
															chat={c}
															active={pathname === `/chat/${c.id}`}
															kbdSelected={walkIndex === kbdIndex}
															onOpen={() => {
																setKbdIndex(null);
																router.push(`/chat/${c.id}`);
															}}
															onContextMenu={(e) => openContext(e, c)}
														/>
													</div>
												);
											})}
										</>
									)}
								</div>
							);
						})
							);
						})()
					)}
				</div>

					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					<ActivitySection />

					{/* Settings entry (settings-app wave): same row language as
					    New session — quiet, bottom-pinned, opens the centered
					    dialog (also mod+, in the keyboard registry). */}
					<div className="px-3 pb-3 pt-1">
						<Hint label="Settings" action="open-settings" side="right">
							<button
								type="button"
								onClick={() => openSettings()}
								data-testid="settings-entry"
								className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<SettingsIcon className="size-3" />
								Settings
							</button>
						</Hint>
					</div>
				</div>

				{/* The context menu (wave 6 + the extraction-UX redesign): the
				    coverage block above, then exactly two management actions
				    (owner ruling — no more). MenuShell owns placement/focus/arrow
				    cycling; the dismissal effect above owns the contract. */}
				{ctxChatId !== null && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						{/* The two management actions first, then the extraction block
						    (owner refinement round, 2026-09-24): Rename/Delete stay at the
						    top, the coverage numbers + Extract affordance sit below the
						    hairline — the block is info + a stateful affordance, the
						    actions above it. Fetched on menu open (the block mounts WITH
						    the menu); 409 = benign. Renders nothing on a failed read. */}
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-move"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setMovingChat(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Move to workspace…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
						<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
						<CoverageMenuBlock chatId={ctxChatId} />
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>

				{/* The move dialog (workspace wave Phase 3): the A3 design's
				    v1 half — destination picker + Unsorted; the graph-traces mode
				    rides this dialog in Phase 5. */}
				<MoveSessionDialog
					chat={movingChat}
					workspaces={workspaces.filter((w) => w.id !== movingChat?.workspaceId)}
					onClose={() => setMovingChat(null)}
					onMoved={onMoved}
				/>
			</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}
