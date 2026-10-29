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
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
function stubEndpoint(models: { id: string }[]): void {
	discovery = { count: 0, urls: [] };
	globalThis.fetch = async (input) => {
		const url = String(input);
		discovery.urls.push(url);
		discovery.count++;
		if (!/^https?:\/\/[^/]+\.invalid(:\d+)?\/v1\/models$/.test(url)) throw new Error(`unexpected network request: ${url}`);
		return Response.json({ object: "list", data: models.map((m) => ({ id: m.id, object: "model" })) });
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
