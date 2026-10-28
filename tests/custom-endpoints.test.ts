/**
 * Tests for the custom-endpoints wave (2026-10-28): the core shape rules
 * (core/settings.ts — slug validation, base URL normalization, the
 * record sanitizer's section handling), the write-side parser
 * (server/settings-body.ts), and the keys seam's custom-key rules
 * (server/keys.ts — writability + the requiresKey-gated presence truth).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CUSTOM_PROVIDER_PREFIX,
	customEndpointEnvVar,
	isCustomProviderId,
	isValidCustomEndpointId,
	sanitizeCustomBaseUrl,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { parseCustomEndpointsSettingsBody } from "../src/server/settings-body.ts";

describe("custom endpoint core rules", () => {
	it("provider id: custom:<slug> — the prefix predicate agrees both ways", () => {
		assert.equal(`${CUSTOM_PROVIDER_PREFIX}:llama`, "custom:llama");
		assert.equal(isCustomProviderId("custom:localhost-8080"), true);
		assert.equal(isCustomProviderId("custom:"), true);
		assert.equal(isCustomProviderId("openrouter"), false);
		assert.equal(isCustomProviderId("chatgpt"), false);
	});

	it("env var: CUSTOM_<slug>_API_KEY round-trips the slug", () => {
		assert.equal(customEndpointEnvVar("localhost-8080"), "CUSTOM_localhost-8080_API_KEY");
	});

	it("slug rules: letters/digits/dash/underscore, digit-first start, ≤32", () => {
		assert.equal(isValidCustomEndpointId("llama-cpp"), true);
		assert.equal(isValidCustomEndpointId("localhost_8080"), true);
		assert.equal(isValidCustomEndpointId("A1"), true);
		assert.equal(isValidCustomEndpointId("-leading"), false);
		assert.equal(isValidCustomEndpointId("has space"), false);
		assert.equal(isValidCustomEndpointId("dot.not"), false);
		assert.equal(isValidCustomEndpointId("x".repeat(33)), false);
		assert.equal(isValidCustomEndpointId(""), false);
	});

	it("base URL: http(s) only, trailing slashes cut, junk drops", () => {
		assert.equal(sanitizeCustomBaseUrl("http://localhost:8080/v1"), "http://localhost:8080/v1");
		assert.equal(sanitizeCustomBaseUrl("https://host.example/v1/"), "https://host.example/v1");
		assert.equal(sanitizeCustomBaseUrl("http://localhost:11434/v1///"), "http://localhost:11434/v1");
		assert.equal(sanitizeCustomBaseUrl("  http://host  "), "http://host");
		assert.equal(sanitizeCustomBaseUrl("ftp://host"), null);
		assert.equal(sanitizeCustomBaseUrl("not a url"), null);
		assert.equal(sanitizeCustomBaseUrl(""), null);
		assert.equal(sanitizeCustomBaseUrl(undefined), null);
	});
});

describe("sanitizeUserSettings — customEndpoints section", () => {
	it("round-trips a valid section", () => {
		const record = {
			version: 1,
			customEndpoints: {
				endpoints: {
					"localhost-8080": { id: "localhost-8080", label: "llama.cpp", baseUrl: "http://localhost:8080/v1", requiresKey: false },
					"host-example": { id: "host-example", baseUrl: "https://host.example/v1" },
				},
			},
		};
		assert.deepEqual(sanitizeUserSettings(record), record);
	});

	it("drops entries with a bad slug, a bad baseUrl, or a map-key/id mismatch", () => {
		const out = sanitizeUserSettings({
			version: 1,
			customEndpoints: {
				endpoints: {
					"bad slug": { id: "bad slug", baseUrl: "http://x" },
					"ok": { id: "ok", baseUrl: "ftp://nope" },
					wrong: { id: "other", baseUrl: "http://y" },
					good: { id: "good", baseUrl: "http://z" },
				},
			},
		});
		assert.ok(out);
		assert.deepEqual(out.customEndpoints, { endpoints: { good: { id: "good", baseUrl: "http://z" } } });
	});

	it("a dotted slug drops (the env-var name must be a slug); the emptied section rides past verbatim", () => {
		const out = sanitizeUserSettings({ version: 1, customEndpoints: { endpoints: { "host.example": { id: "host.example", baseUrl: "https://host.example/v1" } } } });
		assert.ok(out);
		// The entry drops (dots are not slug-legal); the section reconstructs
		// empty — a known section never rides its raw junk past the
		// unknown-key passthrough.
		assert.deepEqual(out.customEndpoints, {});
	});
});

describe("parseCustomEndpointsSettingsBody", () => {
	it("parses a valid map replace-whole", () => {
		const r = parseCustomEndpointsSettingsBody({
			endpoints: {
				"localhost-8080": { id: "localhost-8080", label: "llama.cpp", baseUrl: "http://localhost:8080/v1/", requiresKey: false },
			},
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			endpoints: { "localhost-8080": { id: "localhost-8080", baseUrl: "http://localhost:8080/v1", label: "llama.cpp", requiresKey: false } },
		});
	});

	it("empty body clears the section (replace-whole)", () => {
		const r = parseCustomEndpointsSettingsBody({});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {});
	});

	it("rejects a non-slug id, a non-http baseUrl, a key/id mismatch, a non-string label, a non-boolean toggle", () => {
		assert.equal(parseCustomEndpointsSettingsBody({ endpoints: { "bad slug": { id: "bad slug", baseUrl: "http://x" } } }).ok, false);
		assert.equal(parseCustomEndpointsSettingsBody({ endpoints: { ok: { id: "ok", baseUrl: "nope" } } }).ok, false);
		assert.equal(parseCustomEndpointsSettingsBody({ endpoints: { ok: { id: "other", baseUrl: "http://x" } } }).ok, false);
		assert.equal(parseCustomEndpointsSettingsBody({ endpoints: { ok: { id: "ok", baseUrl: "http://x", label: "  " } } }).ok, false);
		assert.equal(parseCustomEndpointsSettingsBody({ endpoints: { ok: { id: "ok", baseUrl: "http://x", requiresKey: "yes" } } }).ok, false);
	});

	it("normalizes the base URL on the way in (trailing slash cut)", () => {
		const r = parseCustomEndpointsSettingsBody({ endpoints: { ok: { id: "ok", baseUrl: "https://host.example/v1/" } } });
		assert.ok(r.ok);
		if (r.ok) assert.equal(r.settings.endpoints?.ok?.baseUrl, "https://host.example/v1");
	});
});
