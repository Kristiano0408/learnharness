"use client";
/**
 * The Custom endpoints section (custom-endpoints wave, 2026-10-28): the
 * Providers section's user-owned OpenAI-compatible servers — llama.cpp,
 * Ollama, vLLM, LM Studio, or any `<base>/v1`-shaped chat server. Each
 * endpoint lands as a `custom:<slug>` pi-ai provider whose model catalog
 * is discovered live from `GET <base>/v1/models` and federates into the
 * model picker like every keyed provider.
 *
 * Shape mirrors the Keys section (the owner's table language): rows are
 * label + base URL + status, click-unfold the editor. The API key is the
 * Keys section's own machinery — a `CUSTOM_<slug>_API_KEY` row appears in
 * the key table once the endpoint exists (server-side, via the keys seam);
 * this section only carries the endpoint metadata and its key toggle.
 *
 * The save flow: PUT /api/settings/customEndpoints (replace-whole) → the
 * server re-registers the provider + discovers its catalog → a refresh
 * error (dead server) surfaces honestly on the row, never a lie about
 * models.
 */

import { useCallback, useEffect, useState } from "react";
import type { CustomEndpoint } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

/** The row's live status: discovered model count, or the honest error from
 *  the last discovery attempt. */
interface EndpointStatus {
	modelCount?: number;
	error?: string;
}

/** The row's compact status: "N models" once discovered, "unreachable"
 *  when the last probe failed, the raw base URL before any probe. */
function statusLine(status: EndpointStatus | null, endpoint: CustomEndpoint | null): string {
	if (status?.error) return "unreachable";
	if (status?.modelCount !== undefined) return `${status.modelCount} models`;
	return endpoint?.baseUrl ?? "";
}

/** One endpoint row: label left, base URL + status right; click-unfold
 *  edits it (base URL, label, key toggle). Delete lives in the editor. */
function EndpointRow({
	endpoint,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
}: {
	endpoint: CustomEndpoint | null;
	status: EndpointStatus | null;
	expanded: boolean;
	onToggle: () => void;
	onSave: (draft: CustomEndpoint) => Promise<string | null>;
	onDelete: () => Promise<void>;
	onCancel: () => void;
	testid: string;
}) {
	const [label, setLabel] = useState(endpoint?.label ?? "");
	const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
	const [requiresKey, setRequiresKey] = useState(endpoint?.requiresKey ?? false);
	const [vision, setVision] = useState(endpoint?.vision ?? false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// Re-seed the editor when the row behind this editor changes (a reload
	// after save, or switching rows).
	useEffect(() => {
		setLabel(endpoint?.label ?? "");
		setBaseUrl(endpoint?.baseUrl ?? "");
		setRequiresKey(endpoint?.requiresKey ?? false);
		setVision(endpoint?.vision ?? false);
	}, [endpoint?.id, endpoint?.label, endpoint?.baseUrl, endpoint?.requiresKey, endpoint?.vision]);

	async function save() {
		if (!baseUrl.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave({
			id: endpoint?.id ?? slugFrom(baseUrl),
			label: label.trim(),
			baseUrl: baseUrl.trim(),
			requiresKey,
			vision,
		});
		if (err) setError(err);
		setBusy(false);
	}

	if (expanded) {
		return (
			<div data-testid={testid}>
				<div className="flex flex-wrap items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="Label (e.g. llama.cpp)"
						aria-label="Endpoint label"
						data-testid={`${testid}-label`}
						className="h-7 w-40 min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<input
						type="text"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder="http://localhost:8080/v1"
						aria-label="Endpoint base URL"
						data-testid={`${testid}-baseurl`}
						disabled={busy}
						autoFocus
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<label className="flex shrink-0 items-center gap-1.5 font-ui text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={requiresKey}
							onChange={(e) => setRequiresKey(e.target.checked)}
							data-testid={`${testid}-requireskey`}
							className="size-3.5 accent-current"
						/>
						API key
					</label>
					<label className="flex shrink-0 items-center gap-1.5 font-ui text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={vision}
							onChange={(e) => setVision(e.target.checked)}
							data-testid={`${testid}-vision`}
							className="size-3.5 accent-current"
						/>
						Vision
					</label>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !baseUrl.trim()}
						data-testid={`${testid}-save`}
						className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Cancel
					</button>
					{endpoint && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Delete
						</button>
					)}
				</div>
				{(error || status?.error) && (
					<p role="alert" data-testid={`${testid}-error`} className="px-1 text-xs text-red-500">
						{error ?? status?.error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div data-testid={testid}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={onToggle}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
			>
				<span className="font-ui text-xs text-foreground">{endpoint?.label || endpoint?.id || "Custom endpoint"}</span>
				<span className="flex items-center gap-2">
					<span data-testid={`${testid}-status`} className="font-mono text-[11px] text-muted-foreground">
						{statusLine(status, endpoint)}
					</span>
				</span>
			</button>
			{status?.error && (
				<p data-testid={`${testid}-rowerror`} className="pl-6 text-xs text-red-500">
					{status.error}
				</p>
			)}
		</div>
	);
}

/** Derive a stable slug from a base URL for a brand-new endpoint (the
 *  server's own slug rules apply; the server re-validates). */
function slugFrom(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		const host = url.hostname.replace(/[^a-z0-9-]/gi, "_").replace(/^-+|-+$/g, "") || "endpoint";
		const port = url.port ? `-${url.port}` : "";
		return `${host}${port}`.slice(0, 32);
	} catch {
		return "endpoint";
	}
}

export function CustomEndpointsSection({
	endpoints,
	onWrite,
}: {
	/** The record's endpoints (undefined = none yet). */
	endpoints: Record<string, CustomEndpoint> | undefined;
	/** PUT the whole endpoints map (replace-whole). */
	onWrite: (next: Record<string, CustomEndpoint>) => void;
}) {
	const list = Object.values(endpoints ?? {}).sort((a, b) => a.id.localeCompare(b.id));
	const [openRow, setOpenRow] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [statuses, setStatuses] = useState<Record<string, EndpointStatus>>({});
	const [writeError, setWriteError] = useState<string | null>(null);

	/** Pull each endpoint's discovered catalog + reachability from the
	 *  server (the same /api/models payload the picker reads — custom
	 *  providers ride it once synced). */
	const refreshStatuses = useCallback(async (ids: string[]) => {
		if (ids.length === 0) {
			setStatuses({});
			return;
		}
		try {
			const res = await fetch("/api/models", { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as {
				models?: { provider: string }[];
				providers?: { id: string; keyPresent: boolean }[];
			};
			const counts = new Map<string, number>();
			for (const model of body.models ?? []) {
				if (model.provider.startsWith("custom:")) {
					const id = model.provider.slice("custom:".length);
					counts.set(id, (counts.get(id) ?? 0) + 1);
				}
			}
			const next: Record<string, EndpointStatus> = {};
			for (const id of ids) {
				const provider = body.providers?.find((p) => p.id === `custom:${id}`);
				const count = counts.get(id) ?? 0;
				next[id] =
					count > 0
						? { modelCount: count }
						: provider && !provider.keyPresent
							? { error: "key required — add the endpoint key in the table above" }
							: { error: "endpoint unreachable — start the server or check the base URL" };
			}
			setStatuses(next);
		} catch {
			/* keep the last known statuses — a network blip is not a verdict */
		}
	}, []);

	const endpointIds = list.map((e) => e.id).join(",");
	useEffect(() => {
		void refreshStatuses(endpointIds ? endpointIds.split(",") : []);
	}, [endpointIds, refreshStatuses]);

	/** Escape folds any open editor WITHOUT closing the dialog (the Keys
	 *  section's capture-phase pattern, same dismissal stack rule). */
	useEffect(() => {
		if (openRow === null && !adding) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpenRow(null);
			setAdding(false);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openRow, adding]);

	async function writeEndpoints(next: Record<string, CustomEndpoint>): Promise<string | null> {
		setWriteError(null);
		await onWrite(next);
		// The dialog's writer surfaces its own errors via `settings-error`;
		// a stale endpoint map means the write landed (or the server kept
		// the old one) — refresh the discovery either way.
		await refreshStatuses(Object.keys(next));
		notifySettingsSaved("customEndpoints");
		return null;
	}

	async function saveEndpoint(draft: CustomEndpoint): Promise<string | null> {
		const next = { ...(endpoints ?? {}) };
		// A rename (the editor carries the id) never exists server-side:
		// new endpoints get their slug from the base URL.
		next[draft.id] = draft;
		await writeEndpoints(next);
		setOpenRow(null);
		setAdding(false);
		return null;
	}

	async function deleteEndpoint(id: string): Promise<void> {
		const next = { ...(endpoints ?? {}) };
		delete next[id];
		await writeEndpoints(next);
		// The endpoint's auth key (CUSTOM_<id>_API_KEY) stays in auth.json
		// as an unknown var — surfaced read-only by the keys table, exactly
		// like every preserved var. Honest, and deletable there.
		setOpenRow(null);
	}

	const rowFor = (id: string) => list.find((e) => e.id === id) ?? null;

	return (
		<SettingsGroup label="Custom endpoints" testid="group-custom-endpoints">
			{list.map((endpoint) => (
				<EndpointRow
					key={endpoint.id}
					endpoint={rowFor(endpoint.id)}
					status={statuses[endpoint.id] ?? null}
					expanded={openRow === endpoint.id}
					onToggle={() => setOpenRow(openRow === endpoint.id ? null : endpoint.id)}
					onSave={saveEndpoint}
					onDelete={() => deleteEndpoint(endpoint.id)}
					onCancel={() => setOpenRow(null)}
					testid={`custom-endpoint-${endpoint.id}`}
				/>
			))}
			{!adding && (
				<div className="relative">
					<button
						type="button"
						data-testid="add-custom-endpoint"
						onClick={() => {
							setAdding(true);
							setOpenRow(null);
						}}
						className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
					>
						<span>+ Add custom endpoint</span>
						<span className="font-mono text-[11px]">OpenAI-compatible</span>
					</button>
				</div>
			)}
			{adding && (
				<EndpointRow
					endpoint={null}
					status={null}
					expanded
					onToggle={() => {}}
					onSave={saveEndpoint}
					onDelete={async () => {}}
					onCancel={() => setAdding(false)}
					testid="custom-endpoint-new"
				/>
			)}
			{writeError && (
				<p role="alert" data-testid="custom-endpoints-error" className="px-1 text-xs text-red-500">
					{writeError}
				</p>
			)}
			<p data-testid="custom-endpoints-hint" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
				Any OpenAI-compat server (llama.cpp, Ollama, vLLM, LM Studio…): point at its{" "}
				<code className="font-mono">/v1</code> base, models are discovered live. Local servers work keyless;
				checked endpoints gate on their key (the key row appears in the table above once saved).
			</p>
		</SettingsGroup>
	);
}
