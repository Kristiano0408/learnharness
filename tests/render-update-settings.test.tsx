/** Update settings UI tests (manual updates only). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings, MANUAL_UPDATE_HINT } from "../components/settings/update-settings.tsx";
import nextConfig from "../next.config.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const props = { version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	delete window.lh;
	globalThis.fetch = originalFetch;
});

describe("version and contextual copy", () => {
	it("build metadata comes from package.json and exposes only public version/homepage values", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.deepEqual(nextConfig.env, { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage });
	});
});

describe("General update rows — manual updates", () => {
	it("SSR shows version and installed-version release notes, with manual update hint", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes(`${props.homepage}/releases/tag/v0.3.7`));
		assert.ok(html.includes(MANUAL_UPDATE_HINT));
		assert.ok(!html.includes("update-check"));
		assert.ok(!html.includes("row-auto-update"));
	});

	it("renders version row and release notes link cleanly in client DOM", async () => {
		const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version"));
		assert.ok(q(host, "release-notes"));
		assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null);
		assert.ok(host.textContent!.includes(MANUAL_UPDATE_HINT));
	});
});
