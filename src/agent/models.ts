import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type Provider,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import {
	CUSTOM_PROVIDER_PREFIX,
	DEFAULT_THINKING_ORDER,
	customEndpointEnvVar,
	isCustomProviderId,
	type CustomEndpoint,
} from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

// ─── Custom endpoints (custom-endpoints wave, 2026-10-28) ───────────────────
// User-owned OpenAI-compatible servers (llama.cpp / Ollama / vLLM / LM Studio
// / …) registered as dynamic pi-ai providers. Each endpoint rides its own
// provider id `custom:<slug>`, discovered catalog (GET <base>/v1/models) +
// its auth key (`CUSTOM_<slug>_API_KEY`, resolved from process.env by the
// keys seam — the env-wins / fill-gap rules apply untouched). Keyless local
// servers are configured by definition: the provider's auth resolves
// whenever `requiresKey` is off (the faux-provider pattern).

/** The pi-ai provider id for a custom endpoint. */
export function customProviderId(endpointId: string): string {
	return `${CUSTOM_PROVIDER_PREFIX}:${endpointId}`;
}

/** Is a resolved spec's provider a custom endpoint? */
export function isCustomSpec(spec: { provider: string }): boolean {
	return isCustomProviderId(spec.provider);
}

/** The catalog shape a `/v1/models` entry carries (only the fields worth
 *  reading; unknown fields ride past it). */
interface DiscoveredModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	max_tokens?: unknown;
	description?: unknown;
}

/** The conservative catalog floor for a discovered model whose server told
 *  us nothing: 128k context + a 4k answer room. Conservative on purpose —
 *  compaction's min(threshold, window − 16k reserve) keeps the chat honest
 *  even when llama.cpp/Ollama reports no window at all. */
const CUSTOM_DEFAULT_CONTEXT_WINDOW = 128_000;
const CUSTOM_DEFAULT_MAX_TOKENS = 4_096;

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Map one discovered `/v1/models` entry to a pi-ai chat model. Reasoning
 *  stays false (the endpoint's thinking format is not introspectable from
 *  the catalog: a user wanting reasoning output pins the model's level to
 *  "off" or tunes the endpoint directly). */
function toCustomModel(endpoint: CustomEndpoint, entry: DiscoveredModel): Model<"openai-completions"> | undefined {
	if (typeof entry.id !== "string" || !entry.id) return undefined;
	return {
		id: entry.id,
		name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
		api: "openai-completions",
		provider: customProviderId(endpoint.id),
		baseUrl: endpoint.baseUrl,
		// The endpoint's vision toggle is the user's call: llama.cpp/Ollama
		// report image modalities inconsistently across servers, so the
		// toggle (not the discovery) decides whether the model federates
		// into the vision slot's picker.
		input: endpoint.vision ? ["text", "image"] : ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveInt(entry.context_length, CUSTOM_DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInt(entry.max_tokens, CUSTOM_DEFAULT_MAX_TOKENS),
	};
}

/** The live discovery call: GET <base>/v1/models (OpenAI-compat), short
 *  timeout so a dead local server never hangs a settings page. The
 *  discovered entries carry the endpoint's real provider id — the stream
 *  dispatch keys on model.provider. */
async function fetchCustomModels(endpoint: CustomEndpoint, signal: AbortSignal): Promise<Model<"openai-completions">[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	try {
		const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/models`, {
			signal: AbortSignal.any([signal, controller.signal]),
			headers: { accept: "application/json" },
		});
		if (!res.ok) throw new Error(`models discovery failed (${res.status})`);
		const body = (await res.json()) as { data?: unknown };
		const entries = Array.isArray(body.data) ? body.data as DiscoveredModel[] : [];
		const models: Model<"openai-completions">[] = [];
		for (const entry of entries) {
			const model = toCustomModel(endpoint, entry);
			if (model) models.push(model);
		}
		return models;
	} finally {
		clearTimeout(timeout);
	}
}

/** Build the dynamic provider for one custom endpoint. The auth resolve
 *  reads process.env live per request (the same seam pi-ai's builtins use;
 *  a saved key lands through the keys fill-gap with no restart). */
export function customProvider(endpoint: CustomEndpoint): Provider {
	const envVar = customEndpointEnvVar(endpoint.id);
	return createProvider({
		id: customProviderId(endpoint.id),
		name: endpoint.label || endpoint.id,
		baseUrl: endpoint.baseUrl,
		auth: {
			apiKey: {
				name: `${endpoint.label || endpoint.id} key`,
				resolve: async () => {
					const key = process.env[envVar];
					if (key) return { auth: { apiKey: key }, source: envVar };
					if (endpoint.requiresKey) return undefined;
					// Keyless local server: configured by definition (the faux
					// provider's pattern — an empty auth is a configured provider).
					return { auth: { apiKey: "unused" }, source: "keyless" };
				},
			},
		},
		models: [],
		fetchModels: async (context) => fetchCustomModels(endpoint, context.signal),
		api: openAICompletionsApi(),
	});
}

/** Re-register one custom endpoint's provider into the process-wide
 *  collection (idempotent: setProvider upserts by id). A removed endpoint
 *  must be deleted via `removeCustomProvider` — the caller (the server
 *  composition) reconciles the live set against the record. */
export function syncCustomProvider(endpoint: CustomEndpoint): void {
	piModels().setProvider(customProvider(endpoint));
}

/** Drop one custom endpoint's provider + its discovered catalog. */
export function removeCustomProvider(endpointId: string): void {
	piModels().deleteProvider(customProviderId(endpointId));
}

/** Refresh one custom endpoint's discovered catalog (never throws — a dead
 *  server keeps whatever catalog the provider already holds). Returns the
 *  refresh error, when any (the settings UI's honest "endpoint unreachable"). */
export async function refreshCustomProvider(endpointId: string): Promise<Error | undefined> {
	const result = await piModels().refresh({ providers: [customProviderId(endpointId)] });
	return result.errors.get(customProviderId(endpointId));
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const model = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level });
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
