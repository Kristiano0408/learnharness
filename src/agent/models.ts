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
import { MIN_ANSWER_TOKENS } from "@earendil-works/pi-ai/api/simple-options";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import {
	CUSTOM_PROVIDER_PREFIX,
	DEFAULT_THINKING_ORDER,
	THINKING_LEVELS,
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
 *  reading; unknown fields ride past it). llama.cpp-shape servers (strata,
 *  llama.cpp, Ollama) report their window in `meta.n_ctx` instead of the
 *  OpenAI-standard `context_length` — both shapes read. */
interface DiscoveredModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	max_tokens?: unknown;
	meta?: { n_ctx?: unknown };
	description?: unknown;
}

/** The conservative catalog floor for a discovered model when the server
 *  told us nothing anywhere: a 128k context window. Conservative on purpose
 *  — compaction's min(threshold, window − 16k reserve) keeps the chat honest
 *  even when llama.cpp/Ollama reports no window at all. There is NO answer
 *  ceiling floor anymore (2026-10-30): a silent 4096 capped every custom
 *  request invisibly — see toCustomModel's OUTPUT ROOM. */
const CUSTOM_DEFAULT_CONTEXT_WINDOW = 128_000;

/** A non-negative integer, else the fallback. 0 is a LEGAL result (the
 *  custom ceiling chain's "no ceiling" marker: pi-ai skips the cap field
 *  when options.maxTokens is falsy). */
function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Map one discovered `/v1/models` entry to a pi-ai chat model. The
 *  endpoint's THINKING truth (custom thinking wave, 2026-11-03): an
 *  OpenAI-compat server reports nothing reasoning-capable from
 *  `/v1/models`, so the endpoint's `supportedThinkingLevels` toggle is the
 *  user's explicit claim — set = every discovered model federates as a
 *  reasoning model carrying pi's `thinkingLevelMap` (the ladder with "off"
 *  mapped to llama.cpp's documented disable value, and null-marked entries
 *  keeping pi's level validation honest); unset = today's shape untouched
 *  (`reasoning: false`, the picker shows only "off"). */
function toCustomModel(endpoint: CustomEndpoint, entry: DiscoveredModel): Model<"openai-completions"> | undefined {
	if (typeof entry.id !== "string" || !entry.id) return undefined;
	const thinkingLevels = endpoint.supportedThinkingLevels ?? [];
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
		reasoning: thinkingLevels.length > 0,
		// pi's level map (2026-11-03,verified against pi-ai's
		// getSupportedThinkingLevels): a MISSING entry through "high" counts
		// as supported, so the claimed set must be null-marked or the picker
		// would federate levels the user never checked. Claimed levels map to
		// their own name (the wire effort string); the standard ladder
		// minimal/low/medium/high always gets an entry (null = unsupported);
		// xhigh/max stay absent unless claimed (pi: absent = unsupported).
		// THE "off" ENTRY IS THE DISABLE CHANNEL, not decoration (owner fix,
		// 2026-11-06): with NO off entry pi sends NOTHING when thinking is
		// off, and llama.cpp then falls back to the MODEL TEMPLATE'S default —
		// a reasoner template thinks anyway, so "off" looked broken. pi-ai's
		// generic openai-completions branch (openai-completions.js): a STRING
		// thinkingLevelMap.off rides `reasoning_effort: <that string>` when the
		// request level is off — and llama.cpp documents exactly this kill
		// switch (server-common.cpp: reasoning_effort == "none" →
		// enable_thinking = false; tools/server/README.md: "reasoning_effort:
		// If `none`, reasoning/thinking is disabled"). Servers that do not
		// know the value ignore the param like any sampling field — never an
		// error. Non-reasoning endpoints (no levels claimed) keep an empty
		// map: pi's off branch requires model.reasoning, so their wire shape
		// is untouched.
		...(thinkingLevels.length
			? {
					thinkingLevelMap: {
						off: "none",
						...Object.fromEntries(
							THINKING_LEVELS.filter((level) => level !== "off").map((level) => [
								level,
								thinkingLevels.includes(level) ? level : null,
							]),
						),
					},
				}
			: {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// CONTEXT: the standard OpenAI field first, then llama.cpp's
		// `meta.n_ctx` (what local servers actually report, e.g. strata's
		// n_ctx: 262144), then the conservative floor.
		contextWindow: positiveInt(entry.context_length ?? entry.meta?.n_ctx, CUSTOM_DEFAULT_CONTEXT_WINDOW),
		// OUTPUT ROOM (2026-10-30): the user's endpoint ceiling > the entry's
		// own max_tokens > unset. One number with three consumers: honored in
		// the catalog, put on the wire by the engine builder's injected cap,
		// read by pi-ai's thinking-budget room. The old silent 4096 floor is
		// GONE — it capped every custom request invisibly (verified against a
		// live llama.cpp server: the server honors max_tokens, so the floor was
		// an app-side ceiling no one configured). maxTokens 0 = UNSET (pi-ai's
		// falsy check skips the cap field entirely: a server that tells us
		// nothing keeps answering with its own default — today's unchanged
		// behavior). A discovered or configured ceiling is the only thing that
		// puts a cap on the wire (the engine builder injects it).
		maxTokens: positiveInt(endpoint.maxOutputTokens ?? entry.max_tokens, 0),
		// A custom server is a `max_tokens` family: llama.cpp/Ollama/vLLM/LM
		// Studio read `max_tokens` and SILENTLY IGNORE the modern
		// `max_completion_tokens` (verified against a live server, 2026-10-30:
		// the field rode a request pi-ai sent, and the server served its own
		// default instead). pi-ai's URL detection cannot know a localhost, so
		// without this compat the cap would ride a field the server throws
		// away.
		// thinkingTokenBudgetField (custom thinking wave, 2026-11-03,
		// corrected against llama.cpp master + pi-ai's own compat-schema):
		// llama.cpp reads the reasoning cap from `reasoning_budget` top-level
		// OR `thinking_budget_tokens`/`reasoning_budget_tokens` (verified in
		// server-common.cpp: `json_value(body, "reasoning_budget_tokens",
		// json_value(body, "thinking_budget_tokens", -1))`). pi-ai's union
		// documents the same mapping — "thinking_token_budget" is vLLM,
		// "thinking_budget" Qwen/DashScope/SGLang, "thinking_budget_tokens"
		// llama.cpp. The first pick was wrong for a llama.cpp/Ollama server:
		// an unknown field is silently dropped, so the budget was dead weight.
		// `reasoning_effort` stays the level channel (llama.cpp's OAI endpoint
		// passes it to the chat template; off now rides the explicit
		// "none" through the thinkingLevelMap.off entry above — a field that
		// merely ABSSENT leaves to the template default). A server that does
		// not know the budget field ignores it like every other unknown
		// sampling param — never a request error.
		compat: { maxTokensField: "max_tokens", thinkingTokenBudgetField: "thinking_budget_tokens" },
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

// ─── custom catalog integrity (owner ruling, 2026-10-29) ────────────────────
// THE WIPE BUG this section exists to kill: pi-ai's `setProvider` REPLACES the
// provider object, and a provider built by `createProvider` starts with an
// EMPTY dynamic catalog — the models discovered through `fetchModels` live in
// the replaced provider's closure. So re-registering an UNCHANGED endpoint
// silently destroyed its discovered models, and the next lookup threw
// "<provider> catalog has no model <id>" — which is exactly what every
// background engine resolution (the extraction stages and every job) did on
// every single call, while the conversation engine (built without the re-sync)
// kept working.
//
// Two rules follow, and they are the whole fix:
//  1. Re-register only when the endpoint's REQUEST-FACING shape changed.
//     An unchanged endpoint keeps its live provider — and its catalog.
//  2. A miss on a custom provider is not a verdict: it triggers ONE discovery
//     pass (single-flight) before the honest throw. A cold boot, a provider
//     rebuilt by a real config change, or an endpoint restarted with a new
//     model id all self-heal instead of refusing.

interface LhCustomProviderGlobal {
	/** provider id → the endpoint shape currently registered under it. */
	__lhCustomProviderSignatures?: Map<string, string>;
	/** provider id → the in-flight discovery pass (single-flight guard). */
	__lhCustomCatalogFetches?: Map<string, Promise<void>>;
}

/** Process-wide, on globalThis — the same module-instance reason as the
 *  extraction registries: Next dev compiles each route entry as its own
 *  module instance, so a module-level Map would split the truth per route. */
function customState(): { signatures: Map<string, string>; fetches: Map<string, Promise<void>> } {
	const g = globalThis as typeof globalThis & LhCustomProviderGlobal;
	g.__lhCustomProviderSignatures ??= new Map();
	g.__lhCustomCatalogFetches ??= new Map();
	return { signatures: g.__lhCustomProviderSignatures, fetches: g.__lhCustomCatalogFetches };
}

/** What makes a re-register worth its cost (losing the discovered catalog):
 *  the fields the REQUEST path reads — where it talks, whether a key gates
 *  it, and whether its models federate into the vision picker. A label is
 *  display-only and deliberately excluded: renaming an endpoint must not
 *  destroy its catalog, and the settings-save path refreshes anyway. */
function customEndpointSignature(endpoint: CustomEndpoint): string {
	// maxOutputTokens joins (2026-10-30): the ceiling is baked into the
	// provider's discovered models, so changing it IS request-facing — the
	// provider re-registers (and re-discovers) to carry it.
	// The thinking config joins likewise (custom thinking wave,
	// 2026-11-03): reasoning + the level map ride the discovered models too.
	// maxThinkingTokens deliberately does NOT join: it is a per-request
	// option, not part of the provider's catalog shape — changing the budget
	// must not destroy the discovered catalog.
	return JSON.stringify([
		endpoint.baseUrl,
		endpoint.requiresKey === true,
		endpoint.vision === true,
		endpoint.maxOutputTokens ?? null,
		endpoint.supportedThinkingLevels ?? null,
	]);
}

/** Re-register one custom endpoint's provider into the process-wide
 *  collection — IDEMPOTENT in the real sense (custom catalog integrity,
 *  2026-10-29): an endpoint whose registered shape is unchanged keeps its
 *  live provider and everything it discovered. A removed endpoint must be
 *  deleted via `removeCustomProvider` — the caller (the server composition)
 *  reconciles the live set against the record. */
export function syncCustomProvider(endpoint: CustomEndpoint): void {
	const providerId = customProviderId(endpoint.id);
	const state = customState();
	const signature = customEndpointSignature(endpoint);
	if (state.signatures.get(providerId) === signature && piModels().getProvider(providerId)) return;
	piModels().setProvider(customProvider(endpoint));
	state.signatures.set(providerId, signature);
}

/** Drop one custom endpoint's provider + its discovered catalog + its
 *  registered shape (so a re-added endpoint rebuilds instead of riding a
 *  stale signature). */
export function removeCustomProvider(endpointId: string): void {
	const providerId = customProviderId(endpointId);
	piModels().deleteProvider(providerId);
	const state = customState();
	state.signatures.delete(providerId);
	state.fetches.delete(providerId);
}

/** Forget every registered custom shape (test seam: a fresh process behaves
 *  like a fresh process). */
export function resetCustomProviderState(): void {
	const state = customState();
	state.signatures.clear();
	state.fetches.clear();
}

/** Refresh one custom endpoint's discovered catalog (never throws — a dead
 *  server keeps whatever catalog the provider already holds). Returns the
 *  refresh error, when any (the settings UI's honest "endpoint unreachable"). */
export async function refreshCustomProvider(endpointId: string): Promise<Error | undefined> {
	const result = await piModels().refresh({ providers: [customProviderId(endpointId)] });
	return result.errors.get(customProviderId(endpointId));
}

/** ONE discovery pass for one custom endpoint (custom catalog integrity,
 *  2026-10-29): the engine-build path's self-heal. Concurrent misses share
 *  one network call (a fan-out of stage engines over the same cold provider
 *  must not stampede the local server); a dead endpoint leaves the provider
 *  holding whatever catalog it already had, and the caller's miss stays
 *  honest. `refresh` never rejects — errors land in its result map. */
async function ensureCustomCatalog(endpointId: string): Promise<void> {
	const providerId = customProviderId(endpointId);
	const state = customState();
	const inFlight = state.fetches.get(providerId);
	if (inFlight) return inFlight;
	const pass = piModels().refresh({ providers: [providerId] }).then(() => undefined);
	state.fetches.set(providerId, pass);
	try {
		await pass;
	} finally {
		if (state.fetches.get(providerId) === pass) state.fetches.delete(providerId);
	}
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
	/** The resolved reasoning-phase ceiling ladder for THIS spec (custom
	 *  thinking wave, 2026-11-03): chat override > endpoint default >
	 *  undefined. Only a custom provider's stream path reads it — pi caps
	 *  the reasoning phase per level and puts the number on the wire
	 *  through the server's budget field (`thinking_token_budget`). */
	thinkingMaxTokens?: number;
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

/** The catalog lookup one spec resolves to (the sync/async engine builders
 *  share it verbatim): the ChatGPT bridge, a native subscription bridge, or
 *  the federated pi-ai catalog. undefined = the provider's last-known list
 *  does not carry the pinned id. */
function lookupSpecModel(spec: ResolvedModelSpec): Model<Api> | undefined {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	return spec.provider === "chatgpt"
		? chatGPTModel(spec.id)
		: nativeId
			? nativeSubscriptionModel(spec.provider, spec.id)
			: models.getModel(spec.provider, spec.id);
}

/** The engine assembly (model + clamped level + the provider-bound stream
 *  function) — identical for the sync and the discovery-retrying builder. */
function assembleEngine(spec: ResolvedModelSpec, model: Model<Api>, background: boolean | (() => boolean), lifecycle: ChatGPTDispatchLifecycle | undefined): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	// THE REASONING CAP (custom thinking wave, 2026-11-03): the resolved
	// ladder (chat > endpoint) rides pi's `thinkingBudgets` — the
	// openai-completions API caps the reasoning phase per level and emits the
	// number through the compat budget field. pi clamps the budget under the
	// response ceiling (max_tokens ?? model.maxTokens), so a configured
	// ceiling must have an EXPLICIT response ceiling leaving room for it:
	// reasoning cap + MIN_ANSWER_TOKENS (pi's floor for the answer).
	// Without that derivation a no-ceiling endpoint would collapse the budget
	// to zero and silently drop the field (a configured limit is never
	// silently dropped). No ceiling configured: pi-ai's own default ladder
	// governs and the wire shape is untouched — today's unchanged behavior.
	const thinkingCap = isCustomSpec(spec) && level !== "off" ? spec.thinkingMaxTokens : undefined;
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		// THE CUSTOM CAP (2026-10-30): the agent loop never forwards a request
		// maxTokens, and pi-ai omits the max-tokens field entirely when
		// options lack one — a custom server then answers with ITS own
		// default, invisible to the app, and a weak local model silently
		// truncates a submit agent's tool call mid-emission. So the catalog's
		// ceiling (the chain in toCustomModel) rides the request EXPLICITLY,
		// through the compat-picked field. Built-in providers keep pi-ai's
		// exact behavior: no injection there, no behavior change.
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const levelOption = { reasoning: level === "off" ? undefined : level };
			if (isCustomSpec(spec)) {
				return models.streamSimple.bind(models)(requestModel, context, {
					...options,
					...levelOption,
					// With a configured reasoning cap the response ceiling grows
					// to leave pi's answer room (the derivation above); without
					// one this is today's unchanged catalog ceiling.
					maxTokens: thinkingCap ? Math.max(model.maxTokens, thinkingCap + MIN_ANSWER_TOKENS) : model.maxTokens,
					...(thinkingCap
						? { thinkingBudgets: { minimal: thinkingCap, low: thinkingCap, medium: thinkingCap, high: thinkingCap } }
						: {}),
				});
			}
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, { ...options, ...levelOption });
		},
	};
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's.
 *
 *  STRICTLY SYNC, and it stays that way: this is the catalog-read path — a
 *  miss is a verdict. The background engine paths (extraction stages, jobs)
 *  go through `resolveEngineForSpec`, which may discover; a custom provider's
 *  catalog is only guaranteed after a discovery pass, and this entry point
 *  must not start a network call inside a synchronous lookup. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const model = lookupSpecModel(spec);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	return assembleEngine(spec, model, background, lifecycle);
}

/** The engine for a RESOLVED spec, ALLOWING ONE discovery pass (custom
 *  catalog integrity, 2026-10-29): the background engine paths' builder.
 *  Identical to `piEngineForSpec` except that a miss on a CUSTOM endpoint is
 *  not a verdict — the endpoint's `/v1/models` is fetched once (single-flight)
 *  and the lookup retried. That covers every real cold shape: a process that
 *  never read the catalog, a provider rebuilt by a genuine endpoint change,
 *  an endpoint restarted under a new model id. A non-custom provider keeps
 *  the exact sync semantics (no network, no retry). */
export async function resolveEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): Promise<PiEngine> {
	let model = lookupSpecModel(spec);
	if (!model && isCustomProviderId(spec.provider)) {
		await ensureCustomCatalog(spec.provider.slice(CUSTOM_PROVIDER_PREFIX.length + 1));
		model = lookupSpecModel(spec);
	}
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	return assembleEngine(spec, model, background, lifecycle);
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
