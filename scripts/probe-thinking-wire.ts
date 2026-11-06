/**
 * ONE-OFF DIAGNOSTIC PROBE (not part of the suite): run the REAL engine
 * builder against a live custom endpoint and print, for every thinking level,
 * the exact request body that rides the wire. Nothing is hidden — this is
 * what the server actually receives.
 *
 * Usage: npx tsx scripts/probe-thinking-wire.ts <baseUrl> <modelId> [level...]
 *   baseUrl e.g. http://127.0.0.1:9931/v1  (must end in /v1)
 *   modelId e.g. glm-5.3-flash             (must be the id /v1/models reports)
 *   levels  default: off low medium high
 */
import { piEngineForSpec, piModels, removeCustomProvider, syncCustomProvider } from "../src/agent/models.ts";
import type { CustomEndpoint } from "../src/core/settings.ts";

const [baseUrl = "http://127.0.0.1:9931/v1", modelId, ...rest] = process.argv.slice(2);
if (!modelId) {
	console.error("usage: npx tsx scripts/probe-thinking-wire.ts <baseUrl> <modelId> [levels...]");
	process.exit(1);
}
const levels = (rest.length ? rest : ["off", "low", "medium", "high"]) as ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];

// The user's saved endpoint record is NOT touched: this probe registers its
// own fixture provider under the SAME baseUrl, with every level claimed, and
// reads the server's real /v1/models list.
const endpoint: CustomEndpoint = { id: "probe", label: "Wire probe", baseUrl, requiresKey: false, vision: false, supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] };

const bodies: Record<string, Record<string, unknown>> = {};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (url.endsWith("/models")) {
		const res = await fetch(url, { headers: { accept: "application/json" } });
		return res;
	}
	const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
	bodies[url] = body;
	console.log(`\n--- wire body → ${url}`);
	console.log(JSON.stringify({
		model: body.model,
		max_tokens: body.max_tokens,
		reasoning_effort: body.reasoning_effort,
		thinking_budget_tokens: body.thinking_budget_tokens,
		chat_template_kwargs: body.chat_template_kwargs,
		stream: body.stream,
	}, null, 2));
	const keys = new Set(Object.keys(body));
	const unknown = [...keys].filter((k) => !["model", "messages", "stream", "stream_options", "max_tokens", "temperature", "tools", "tool_choice", "response_format", "seed", "stop"].includes(k));
	console.log("non-standard fields riding:", unknown.join(", ") || "(none)");
	return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

syncCustomProvider(endpoint);
const provider = "custom:probe";
try {
	// Discovery first (a sync engine build needs the catalog present).
	const modelsRes = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`);
	const listed = (await modelsRes.json().catch(() => null)) as { data?: { id?: string }[] } | null;
	const realIds = (listed?.data ?? []).map((m) => m.id).filter(Boolean);
	if (!realIds.includes(modelId)) {
		console.error(`model "${modelId}" not in this server's /v1/models (${realIds.join(", ")})`);
		process.exit(1);
	}
	const model = piModels().getModel(provider, modelId);
	console.log(`catalog model: ${model?.provider}:${model?.id} reasoning=${model?.reasoning}`);
	for (const level of levels) {
		const engine = piEngineForSpec({ provider, id: modelId, thinkingLevel: level });
		console.log(`\n### level=${level} → engine pins level=${engine.level}`);
		const result = engine.streamFn(engine.model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] } as never, {} as never);
		await result.result().catch(() => undefined);
	}
} finally {
	removeCustomProvider(endpoint.id);
	globalThis.fetch = (await import("node:undici" in {} ? "node:undici" : "node:module").then(() => globalThis.fetch)) as typeof fetch;
}
