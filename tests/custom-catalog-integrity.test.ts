/**
 * CUSTOM CATALOG INTEGRITY (owner ruling, 2026-10-29) — the regression suite
 * for the bug that broke every notes import and every background job on a
 * custom endpoint:
 *
 *   pi-ai's `setProvider` REPLACES the provider object, and a provider built
 *   by `createProvider` starts with an EMPTY dynamic catalog. So re-registering
 *   an UNCHANGED endpoint destroyed its discovered models, and the next lookup
 *   threw "custom:<id> catalog has no model <id>". `resolveEngine` did exactly
 *   that on EVERY extraction stage and EVERY job — while the conversation
 *   engine (built without the re-sync) kept working, which is why a session
 *   ran and an import of the same model did not.
 *
 * Pinned here:
 *   1. re-syncing an unchanged endpoint keeps its live provider AND its
 *      discovered catalog (the wipe is gone);
 *   2. a miss on a custom provider triggers ONE discovery pass (single-flight)
 *      and the retry lands — cold boot, rebuilt provider, moved server;
 *   3. the sync builder stays sync: no network, a miss is a verdict;
 *   4. a genuine endpoint change DOES re-register (and re-discovers);
 *   5. a removed endpoint drops its signature (re-adding rebuilds);
 *   6. a dead endpoint stays honest — the miss throws what it always threw;
 *   7. the widened engineFor seams (job runner + extraction pipeline) accept
 *      async seams and keep working for sync scripted engines.
 *
 * Hermetic: every /v1/models call is a stubbed fetch on a .invalid host —
 * this suite never touches a real server, data/, or the settings record.
 * Fixture endpoint ids are PER TEST: pi-ai persists a discovered catalog per
 * provider id, so a shared id would restore another test's catalog and mask
 * the cold-start behaviour these tests pin.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getSupportedThinkingLevels, normalizeContext } from "@earendil-works/pi-ai";
import {
	piEngineForSpec,
	piModels,
	resolveEngineForSpec,
	removeCustomProvider,
	resetCustomProviderState,
	syncCustomProvider,
	type PiEngine,
} from "../src/agent/models.ts";
import { syncCustomProvidersFromRecord } from "../src/server/model-catalog.ts";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";
import { readFileSync } from "node:fs";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";
import type { CustomEndpoint } from "../src/core/settings.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphChain, GraphNode, NotesSource } from "../src/core/contracts.ts";

const MODEL_ID = "fixture-model-iq3";

// ─── hermetic /v1/models stub ────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
interface Discovery { count: number; urls: string[] }
let discovery: Discovery;

/** Serve `models` on every fixture endpoint's discovery URL, counting every
 *  call. A request that is not a fixture /models call is a hard failure (the
 *  web-subscriptions discipline). */
function stubEndpoint(models: { id: string; max_tokens?: number; context_length?: number; meta?: { n_ctx: number } }[]): void {
	discovery = { count: 0, urls: [] };
	globalThis.fetch = async (input) => {
		const url = String(input);
		discovery.urls.push(url);
		discovery.count++;
		if (!/^https?:\/\/[^/]+\.invalid(:\d+)?\/v1\/models$/.test(url)) throw new Error(`unexpected network request: ${url}`);
		return Response.json({ object: "list", data: models.map((m) => {
			const entry: Record<string, unknown> = { id: m.id, object: "model" };
			if (m.max_tokens !== undefined) entry.max_tokens = m.max_tokens;
			if (m.context_length !== undefined) entry.context_length = m.context_length;
			if (m.meta !== undefined) entry.meta = m.meta;
			return entry;
		}) });
	};
}

/** The endpoint is DOWN: every request throws (a stopped llama.cpp/Ollama). */
function deadEndpoint(): void {
	discovery = { count: 0, urls: [] };
	globalThis.fetch = async (input) => {
		discovery.count++;
		discovery.urls.push(String(input));
		throw new Error("ECONNREFUSED fixture");
	};
}

/** A per-test endpoint + its provider id + the spec pinned to its model. */
function fixture(id: string, overrides: Partial<CustomEndpoint> = {}): {
	endpoint: CustomEndpoint;
	provider: string;
	spec: { provider: string; id: string; thinkingLevel: "off" };
} {
	const endpoint: CustomEndpoint = { id, label: `Fixture ${id}`, baseUrl: `http://${id}.invalid:8081/v1`, requiresKey: false, vision: true, ...overrides };
	return { endpoint, provider: `custom:${id}`, spec: { provider: `custom:${id}`, id: MODEL_ID, thinkingLevel: "off" } };
}

function catalog(provider: string): string[] {
	return piModels().getModels(provider).map((m) => m.id);
}

beforeEach(() => {
	// A fresh process behaves like a fresh process: no carried signatures, no
	// carried providers, no carried in-flight passes.
	resetCustomProviderState();
	for (const provider of piModels().getProviders()) {
		if (provider.id.startsWith("custom:")) piModels().deleteProvider(provider.id);
	}
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ─── 1. THE WIPE BUG (the reported failure) ──────────────────────────────────

describe("re-syncing an unchanged endpoint preserves its catalog", () => {
	it("register → discover → re-sync: the discovered model survives", async () => {
		const { endpoint, provider, spec } = fixture("wipe-survives");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		assert.deepEqual(catalog(provider), [], "a freshly registered provider starts empty (the pi-ai truth)");

		await resolveEngineForSpec(spec);
		assert.deepEqual(catalog(provider), [MODEL_ID], "the discovery pass populated the catalog");
		assert.equal(discovery.count, 1);

		// THE BUG'S EXACT SHAPE: the composition root re-syncs the record before
		// building the next stage engine. Pre-fix this emptied the catalog and
		// the next lookup threw "custom:… catalog has no model …".
		for (let i = 0; i < 5; i++) syncCustomProvider(endpoint);
		assert.deepEqual(catalog(provider), [MODEL_ID], "an unchanged endpoint keeps everything it discovered");
		assert.equal(discovery.count, 1, "the preserved catalog needs no re-discovery");

		const engine = piEngineForSpec(spec); // the SYNC builder now resolves it, no network
		assert.equal(engine.model.id, MODEL_ID);
		assert.equal(discovery.count, 1, "the sync builder did not touch the network");
	});

	it("the composition root's record reconciliation is wipe-free too", async () => {
		const { endpoint, provider, spec } = fixture("reconcile");
		stubEndpoint([{ id: MODEL_ID }]);
		const record = { customEndpoints: { endpoints: { [endpoint.id]: endpoint } } };
		syncCustomProvidersFromRecord(record);
		await resolveEngineForSpec(spec);
		assert.deepEqual(catalog(provider), [MODEL_ID]);

		// resolveEngine reads the settings record FRESH per stage call — the same
		// record, reconciled again and again.
		for (let i = 0; i < 5; i++) syncCustomProvidersFromRecord(record);
		assert.deepEqual(catalog(provider), [MODEL_ID], "reconciling the same record never empties the catalog");
		assert.equal(discovery.count, 1);
	});

	it("a label-only edit is display-only: no re-register, no re-discovery", async () => {
		const { endpoint, provider, spec } = fixture("label-only");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec(spec);
		assert.equal(discovery.count, 1);

		syncCustomProvider({ ...endpoint, label: "Renamed mid-session" });
		assert.deepEqual(catalog(provider), [MODEL_ID], "renaming an endpoint must not destroy its catalog");
		assert.equal(discovery.count, 1, "a display-only change costs no network");
	});
});

// ─── 2. COLD BOOT / DISCOVERY ON A MISS ──────────────────────────────────────

describe("a custom miss discovers once, then resolves", () => {
	it("a process that never read the catalog self-heals on the first engine build", async () => {
		const { endpoint, provider, spec } = fixture("cold-boot");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint); // boot: registration only — no catalog read happened
		assert.deepEqual(catalog(provider), []);

		const engine = await resolveEngineForSpec(spec);
		assert.equal(engine.model.id, MODEL_ID);
		assert.equal(engine.model.provider, provider);
		assert.equal(engine.level, "off");
		assert.deepEqual(discovery.urls, [`http://${endpoint.id}.invalid:8081/v1/models`], "the discovery is the endpoint's OpenAI-compat list");
	});

	it("concurrent misses share ONE discovery pass (no stampede on the local server)", async () => {
		const { endpoint, spec } = fixture("concurrent");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		// The extraction pipeline's real fan-out: both stages resolve off the
		// same cold provider, in parallel.
		const [extractor, auditor] = await Promise.all([resolveEngineForSpec(spec), resolveEngineForSpec(spec)]);
		assert.equal(extractor.model.id, MODEL_ID);
		assert.equal(auditor.model.id, MODEL_ID);
		assert.equal(discovery.count, 1, "one network call for N concurrent misses");
	});

	it("the discovered catalog carries the endpoint's real provider id (stream dispatch keys on it)", async () => {
		const { endpoint, provider, spec } = fixture("provider-id");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec(spec);
		assert.equal(engine.model.provider, provider);
		assert.equal(piModels().getProvider(provider)?.baseUrl, endpoint.baseUrl);
	});

	it("a moved server under a NEW model id self-heals on the next miss", async () => {
		const { endpoint, provider, spec } = fixture("moved");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec(spec);
		assert.deepEqual(catalog(provider), [MODEL_ID]);

		// The local server moved port AND serves a different quant: the
		// endpoint's request-facing shape genuinely changed → re-register → the
		// fresh provider starts empty → the next miss discovers the new list.
		stubEndpoint([{ id: "fixture-model-q4" }]);
		syncCustomProvider({ ...endpoint, baseUrl: `http://${endpoint.id}.invalid:8082/v1` });
		assert.deepEqual(catalog(provider), [], "a real change re-registers, and the fresh provider starts empty");
		const engine = await resolveEngineForSpec({ ...spec, id: "fixture-model-q4" });
		assert.equal(engine.model.id, "fixture-model-q4");
	});
});

// ─── 3. THE SYNC BUILDER STAYS SYNC ──────────────────────────────────────────

describe("piEngineForSpec keeps its strictly-sync contract", () => {
	it("a custom miss does NOT start a network call — the miss is the verdict", () => {
		const { endpoint, provider, spec } = fixture("sync-miss");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		assert.throws(
			() => piEngineForSpec(spec),
			new RegExp(`^Error: ${provider.replace(":", "\\:")} catalog has no model ${MODEL_ID}$`),
			"the catalog-read path must not discover — resolveEngineForSpec is the discovering builder",
		);
		assert.equal(discovery.count, 0, "no network from a synchronous catalog read");
	});

	it("a non-custom provider keeps the exact sync semantics (no discovery, no retry)", async () => {
		stubEndpoint([{ id: MODEL_ID }]);
		await assert.rejects(
			resolveEngineForSpec({ provider: "openrouter", id: "nope/nope", thinkingLevel: "off" }),
			/catalog has no model/,
		);
		assert.equal(discovery.count, 0, "the discovery pass is custom-endpoint-only");
	});

	it("a dead custom endpoint stays honest: the miss throws what it always threw", async () => {
		const { endpoint, provider, spec } = fixture("dead-endpoint");
		deadEndpoint();
		syncCustomProvider(endpoint);
		await assert.rejects(resolveEngineForSpec(spec), new RegExp(`catalog has no model ${MODEL_ID}`));
		assert.deepEqual(catalog(provider), [], "a failed discovery keeps the previous (empty) catalog");
		assert.equal(discovery.count, 1, "one honest attempt, no retry storm");
	});

	it("a key-required endpoint without its key does not stampede the network", async () => {
		const { endpoint, spec } = fixture("gated", { requiresKey: true });
		stubEndpoint([{ id: MODEL_ID }]);
		delete process.env.CUSTOM_fixture_gated_API_KEY;
		syncCustomProvider(endpoint);
		await assert.rejects(resolveEngineForSpec(spec), /catalog has no model/);
		assert.equal(discovery.count, 0, "an unconfigured provider is skipped by pi-ai's refresh — no call");
	});
});

// ─── 4. RECONCILIATION: REMOVAL AND RE-ADD ───────────────────────────────────

describe("the composition root's reconciliation drops stale signatures", () => {
	it("a removed endpoint leaves no provider and no signature; re-adding rebuilds", async () => {
		const { endpoint, provider, spec } = fixture("remove-readd");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvidersFromRecord({ customEndpoints: { endpoints: { [endpoint.id]: endpoint } } });
		await resolveEngineForSpec(spec);
		assert.deepEqual(catalog(provider), [MODEL_ID]);

		// The endpoint is deleted from the record: the provider AND its signature
		// must both go, or a re-added endpoint would ride a stale signature and
		// never rebuild.
		syncCustomProvidersFromRecord({ customEndpoints: { endpoints: {} } });
		assert.equal(piModels().getProvider(provider), undefined, "the provider is gone");
		assert.deepEqual(catalog(provider), []);

		syncCustomProvidersFromRecord({ customEndpoints: { endpoints: { [endpoint.id]: endpoint } } });
		assert.deepEqual(catalog(provider), [], "re-adding rebuilds a fresh provider (no stale signature)");
		const engine = await resolveEngineForSpec(spec);
		assert.equal(engine.model.id, MODEL_ID, "and the re-added endpoint discovers again");
	});

	it("removeCustomProvider drops the in-flight pass without resurrecting the provider", async () => {
		const { endpoint, provider } = fixture("inflight");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const pending = resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "off" });
		removeCustomProvider(endpoint.id);
		await pending.catch(() => undefined); // the shared pass settles either way — no unhandled rejection
		assert.equal(piModels().getProvider(provider), undefined, "a deleted provider stays deleted");
		assert.deepEqual(catalog(provider), []);
	});
});

// ─── 5. THE WIDENED SEAMS (extraction pipeline) ──────────────────────────────

/** Compact in-memory GraphStore (the notes-import-route fixture shape). */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const sources = new Map<string, NotesSource>();
	return {
		appendNode: (node) => { nodes.push(node); },
		readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); },
		readChains: () => [...chains],
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: () => {},
		readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: () => {},
	} satisfies GraphStore;
}

const NULL_CHAT_STORE = { getChat: () => null, createChat: () => ({ id: "unused" }), saveMessages: () => {}, getMessages: () => [] } as never;

function fauxStage(role: "extractor" | "auditor"): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([
		fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor"
			? { propositions: [{ id: "p1", name: "Fixture proposition", statement: "The async seam feeds a real stage.", aliases: [] }], chains: [] }
			: { links: [] }, { id: `call_${role}` }),
	], { stopReason: "toolUse" })]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("the engineFor seams accept async resolution", () => {
	it("an ASYNC engineFor feeds a real notes import end to end (the reported failure path)", async () => {
		const ledgers = memoryLedgers();
		const consulted: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore: NULL_CHAT_STORE,
			graphStore: ledgers,
			// The production shape: the seam returns a PROMISE (a custom engine
			// may discover its catalog first). Pre-fix this seam was sync-only.
			engineFor: async (role) => {
				consulted.push(role);
				await Promise.resolve();
				return fauxStage(role as "extractor" | "auditor");
			},
		});
		const stats = await pipeline.importNotes({ filePath: "fixture.md", text: "The fixture note states one proposition." });
		assert.equal(stats.nodes, 1, "the async-fed pipeline merged the proposition");
		assert.deepEqual(consulted.slice(0, 2), ["extractor", "auditor"], "both stages resolved through the async chain, in pipeline order");
	});

	it("a SYNC engineFor still works (every existing test's scripted engine)", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore: NULL_CHAT_STORE,
			graphStore: ledgers,
			engineFor: (role) => fauxStage(role as "extractor" | "auditor"),
		});
		const stats = await pipeline.importNotes({ filePath: "sync.md", text: "The sync seam is untouched." });
		assert.equal(stats.nodes, 1);
	});

	it("a direct test value short-circuits the chain (the priority pin survives)", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore: NULL_CHAT_STORE,
			graphStore: ledgers,
			extractor: fauxStage("extractor"),
			auditor: fauxStage("auditor"),
			engineFor: () => { throw new Error("engineFor must not be consulted when direct values are set"); },
		});
		const stats = await pipeline.importNotes({ filePath: "direct.md", text: "Direct values win." });
		assert.equal(stats.nodes, 1);
	});

	it("an empty async chain still refuses with ModelsNotConfiguredError (BYOK gate intact)", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore: NULL_CHAT_STORE,
			graphStore: ledgers,
			engineFor: async () => undefined,
		});
		await assert.rejects(
			pipeline.importNotes({ filePath: "empty.md", text: "No engine anywhere." }),
			ModelsNotConfiguredError,
			"the refusal stays typed and lands BEFORE any stage runs",
		);
		assert.equal(ledgers.readNodes().length, 0, "a refusal merged nothing");
	});
});

// ─── 6. THE OUTPUT CEILING (custom endpoints, 2026-10-30) ──────────────────
describe("the custom endpoint's answer ceiling", () => {
	it("discovery honors meta.n_ctx (llama.cpp/strata shape) and the user's maxOutputTokens chain", async () => {
		const { endpoint, provider } = fixture("ceiling-catalog");
		globalThis.fetch = async (input) => {
			if (!/\/v1\/models$/.test(String(input))) throw new Error(`unexpected network request: ${input}`);
			return Response.json({ object: "list", data: [{ id: MODEL_ID, meta: { n_ctx: 262144 } }] });
		};
		syncCustomProvider(endpoint);
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		const [model] = piModels().getModels(provider);
		assert.ok(model, "the fixture model landed in the catalog");
		assert.equal(model.contextWindow, 262144, "meta.n_ctx rides the catalog — a reported window never falls to the floor");
		assert.equal(model.maxTokens, 0, "no endpoint ceiling, no server report: UNSET — pi-ai sends no cap (unchanged behavior)");

		// The user's ceiling wins over everything the server reported.
		syncCustomProvider({ ...endpoint, maxOutputTokens: 16384 }); // signature-changed → re-register
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		const [kept] = piModels().getModels(provider);
		assert.ok(kept, "the re-registered catalog carries the fixture model");
		assert.equal(kept.maxTokens, 16384, "the endpoint's maxOutputTokens is the ceiling chain's top rung");
	});

	it("maxOutputTokens is request-facing: changing it re-registers (and re-discovers) the provider", async () => {
		const { endpoint } = fixture("ceiling-signature");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(discovery.count, 1);
		syncCustomProvider({ ...endpoint, maxOutputTokens: 8192 }); // a real request-facing change
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(discovery.count, 2, "the ceiling change re-registered the provider — the fresh catalog carries it");
	});

	it("THE WIRE: a custom engine sends the cap through max_tokens (llama.cpp ignores max_completion_tokens)", async () => {
		const { endpoint, provider } = fixture("ceiling-wire", { maxOutputTokens: 16384 });
		stubEndpoint([{ id: MODEL_ID, meta: { n_ctx: 32768 }, context_length: 32768 }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(engine.model.maxTokens, 16384, "the endpoint ceiling lands in the catalog");
		let sentBody: Record<string, unknown> | undefined;
		const captureFetch = (async (input, init) => {
			sentBody = JSON.parse(String(init?.body));
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		const result = engine.streamFn(
			engine.model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }),
			{ apiKey: "fixture-key", fetch: captureFetch },
		);
		await result.result().catch(() => undefined); // the fake SSE ends the stream early — the body is the point
		assert.ok(sentBody, "the request reached fetch");
		assert.equal(sentBody.max_tokens, 16384, "the cap rides the field llama.cpp honors (verified live: max_completion_tokens is silently ignored)");
		assert.equal("max_completion_tokens" in sentBody, false, "never the modern field a local server throws away");
	});

	it("THE WIRE: no user ceiling + no server report → NO cap on the wire (unchanged behavior)", async () => {
		const { endpoint, provider } = fixture("ceiling-wire-absent");
		stubEndpoint([{ id: MODEL_ID }]); // reports nothing: neither max_tokens nor window
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		let sentBody: Record<string, unknown> | undefined;
		const captureFetch = (async (input, init) => {
			sentBody = JSON.parse(String(init?.body));
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		const result = engine.streamFn(
			engine.model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }),
			{ apiKey: "fixture-key", fetch: captureFetch },
		);
		await result.result().catch(() => undefined);
		assert.ok(sentBody);
		assert.equal("max_tokens" in sentBody, false, "no ceiling anywhere: pi-ai's no-cap default rides on — unchanged behavior");
	});

	it("A BUILT-IN provider rides no injected cap (pi-ai's exact behavior preserved)", async () => {
		const [openaiModel] = piModels().getModels("openai");
		assert.ok(openaiModel, "the built-in openai catalog is loaded in this suite");
		let sentBody: Record<string, unknown> | undefined;
		const captureFetch = (async (input, init) => {
			sentBody = JSON.parse(String(init?.body));
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		const engine = piEngineForSpec({ provider: "openai", id: openaiModel.id, thinkingLevel: "off" });
		const result = engine.streamFn(
			engine.model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }),
			{ apiKey: "fixture-key", fetch: captureFetch },
		);
		await result.result().catch(() => undefined);
		assert.ok(sentBody);
		assert.equal("max_tokens" in sentBody, false, "no cap injected for a built-in");
	});
});

// ─── 7b. CUSTOM THINKING: LEVELS + REASONING BUDGET (2026-11-03) ───────────

/** Capture one streamFn dispatch's request body through a fake SSE end. */
async function captureWire(engine: PiEngine): Promise<Record<string, unknown> | undefined> {
	let sentBody: Record<string, unknown> | undefined;
	const captureFetch = (async (input, init) => {
		sentBody = JSON.parse(String(init?.body));
		return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	const result = engine.streamFn(
		engine.model,
		normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }),
		{ apiKey: "fixture-key", fetch: captureFetch },
	);
	await result.result().catch(() => undefined);
	return sentBody;
}

describe("the custom endpoint's thinking config (catalog + wire)", () => {
	it("supportedThinkingLevels federates the model as a reasoning model with exactly those levels", async () => {
		const { endpoint, provider, spec } = fixture("thinking-catalog", { supportedThinkingLevels: ["low", "medium"] });
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec(spec);
		const [model] = piModels().getModels(provider);
		assert.ok(model);
		assert.equal(model.reasoning, true, "the user's claim lands as the catalog's reasoning truth");
		// The picker's ladder: off (implicit) + exactly the claimed levels.
		assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "medium"]);
	});

	it("no levels claimed: today's shape untouched — reasoning false, only off", async () => {
		const { endpoint, provider, spec } = fixture("thinking-absent");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec(spec);
		const [model] = piModels().getModels(provider);
		assert.ok(model);
		assert.equal(model.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
	});

	it("the level claim is request-facing (re-register + re-discover); a budget change is not", async () => {
		const { endpoint } = fixture("thinking-signature");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(discovery.count, 1);
		syncCustomProvider({ ...endpoint, supportedThinkingLevels: ["low"] }); // request-facing → re-register
		await resolveEngineForSpec({ provider: `custom:${endpoint.id}`, id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(discovery.count, 2, "the level change re-registered the provider — the fresh catalog carries it");
		syncCustomProvider({ ...endpoint, supportedThinkingLevels: ["low"], maxThinkingTokens: 8192 }); // per-request option → NO re-register
		assert.equal(discovery.count, 2, "a budget change must not destroy the discovered catalog");
	});

	it("THE WIRE: thinking on + a resolved ceiling → reasoning_effort and thinking_budget_tokens ride together", async () => {
		const { endpoint, provider } = fixture("thinking-wire", { supportedThinkingLevels: ["low", "high"], maxThinkingTokens: 4096 });
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "low", thinkingMaxTokens: 2048 });
		assert.equal(engine.level, "low");
		const sentBody = await captureWire(engine);
		assert.ok(sentBody);
		assert.equal(sentBody.reasoning_effort, "low", "the claimed level rides the effort field the template reads");
		// The chat's own override (2048) wins over the endpoint default (4096).
		assert.equal(sentBody.thinking_budget_tokens, 2048, "the resolved ladder lands on the wire through llama.cpp's budget field (server-common.cpp reads thinking_budget_tokens; pi-ai's compat union maps it the same way)");
	});

	it("THE WIRE: thinking on + no ceiling configured → pi's default ladder clamps under the answer room", async () => {
		const { endpoint, provider } = fixture("thinking-wire-default", { supportedThinkingLevels: ["high"] });
		stubEndpoint([{ id: MODEL_ID, max_tokens: 16384 }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "high" });
		const sentBody = await captureWire(engine);
		assert.ok(sentBody);
		assert.equal(sentBody.reasoning_effort, "high");
		// pi's default high budget (16384) clamps under the 16384-token response
		// ceiling to leave MIN_ANSWER_TOKENs for the answer — a reasoning phase
		// can never silently eat the whole response.
		assert.equal(sentBody.thinking_budget_tokens, 16384 - 1024);
	});

	it("THE WIRE: thinking off rides the EXPLICIT kill switch, not an empty request", async () => {
		const { endpoint, provider } = fixture("thinking-wire-off", { supportedThinkingLevels: ["low", "high"], maxThinkingTokens: 4096 });
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "off", thinkingMaxTokens: 2048 });
		const sentBody = await captureWire(engine);
		assert.ok(sentBody);
		// The owner's off fix (2026-11-06): an ABSENT effort field is NOT off —
		// llama.cpp then falls back to the model template's own default and a
		// reasoner thinks anyway. The documented kill switch is the explicit
		// reasoning_effort: "none" (server-common.cpp: == "none" →
		// enable_thinking = false), carried through thinkingLevelMap.off.
		assert.equal(sentBody.reasoning_effort, "none", "off rides llama.cpp's documented disable value");
		assert.equal("thinking_budget_tokens" in sentBody, false, "a budget with thinking off would be a lie");
	});

	it("THE WIRE: a NO-levels endpoint keeps the empty shape (off changes nothing there)", async () => {
		const { endpoint, provider } = fixture("thinking-wire-off-unclaimed");
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "off" });
		const sentBody = await captureWire(engine);
		assert.ok(sentBody);
		assert.equal("reasoning_effort" in sentBody, false, "reasoning: false keeps pi's off branch closed — today's unchanged wire");
		assert.equal("thinking_budget_tokens" in sentBody, false);
	});

	it("a pinned level outside the claim clamps to the nearest supported (the clamp-on-write truth)", async () => {
		const { endpoint, provider } = fixture("thinking-clamp", { supportedThinkingLevels: ["low"] });
		stubEndpoint([{ id: MODEL_ID }]);
		syncCustomProvider(endpoint);
		const engine = await resolveEngineForSpec({ provider, id: MODEL_ID, thinkingLevel: "high" });
		assert.equal(engine.level, "low", "pi's nearest-supported clamp — the pin adapts honestly");
	});
});

// ─── 7. THE AUDITOR'S GROUND (read_graph, 2026-10-30) ──────────────────────
describe("the auditor's one-call ground (the turn-budget fix)", () => {
	it("the procedure reads the graph whole in ONE call and submits immediately", () => {
		const extractionSource = readFileSync(new URL("../src/agent/subagents/extraction.ts", import.meta.url), "utf8");
		assert.match(extractionSource, /1\. GROUND yourself first: call read_graph ONCE\./, "read_graph is the ground procedure — not the per-session crawl");
		assert.match(extractionSource, /2\. SUBMIT\. With the whole ground seen/, "submit immediately after one read — no re-search loop");
	});

	it("the auditor's toolset carries read_graph beside the fallback reads", async () => {
		const tools = auditorGraphTools({ chatStore: NULL_CHAT_STORE, graphStore: memoryLedgers() as never });
		assert.ok(tools.read_graph, "read_graph joins the auditor's set");
		const out = (await tools.read_graph!.execute!("tc", {} as never)).details as string;
		assert.match(out, /empty/, "an empty graph answers honestly");
	});
});
