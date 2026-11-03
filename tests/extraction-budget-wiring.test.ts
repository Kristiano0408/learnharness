/** THE COMPOSITION-ROOT WIRING GUARD (2026-10-30): the chunk budget's two
 *  read sites — the trigger (turn-service) and the pipeline batcher. The
 *  server wiring bug this guard pins: `createExtractionPipeline` in
 *  src/server/chat-handler.ts never passed `getChunkTokens`, so every run
 *  silently fell back to the FACTORY 4096 while the trigger compared
 *  against the SAVED value — a saved budget changed nothing observable.
 *  The guard pins the wiring at its single seam: the pipeline's construction
 *  must wire `getChunkTokens` to the fresh settings read, and the notes door
 *  must share the same number. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chatHandlerFile = fileURLToPath(new URL("../src/server/chat-handler.ts", import.meta.url));
const chatHandlerSource = readFileSync(chatHandlerFile, "utf8");

describe("the server's extraction pipeline wires the saved chunk budget", () => {
	it("createExtractionPipeline carries getChunkTokens — the saved number reaches the batcher", () => {
		const call = chatHandlerSource.match(/createExtractionPipeline\(\{[\s\S]*?\n\}\);/);
		assert.ok(call, "the pipeline construction block is locatable");
		assert.match(call[0], /getChunkTokens:\s*\(\)\s*=>\s*effectiveSettings\(\)\.graph\.extractionChunkTokens/, "the saved budget rides fresh per run — never the factory fallback");
	});

	it("the trigger seam still compares against the same resolved number (one truth, two sites)", () => {
		assert.match(chatHandlerSource, /triggerExtraction\([\s\S]*?effectiveSettings\(\)\.graph\.extractionChunkTokens|effective\.graph\.extractionChunkTokens/, "the trigger reads the same knob");
	});
});
