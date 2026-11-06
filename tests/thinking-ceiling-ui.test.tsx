import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client"; // type-only: erased, no early evaluation
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse } from "../src/core/contracts.ts";

/** THE REASONING CEILING UI (custom thinking wave fix, 2026-11-06): the
 *  owner's "non mi fa scrivere il numero max di token" — the ceiling field in
 *  the chat Thinking menu must be WRITABLE and its value must LAND. Pinned:
 *  1. the input rides only where it has an effect (custom provider + thinking
 *     on); off hides it (the field would be decoration);
 *  2. Enter writes; blur commits too — clicking away must not eat the typed
 *     number (the reported failure);
 *  3. a committed-then-blurred value does NOT double-write;
 *  4. clearing commits the unset state (empty = endpoint default / pi's ladder). */

const dom = parseHTML("<html><body></body></html>");
// linkedom's Document does not expose `oninput`; react-dom's feature check
// would fall back to its legacy IE polyfill (attachEvent), which crashes on
// linkedom nodes. A null field keeps `"oninput" in document` true → the
// modern input/change path (dictation-picker does the same).
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} }, requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) });
// linkedom lacks the modern event constructors the picker's interactions dispatch.
class ShimKeyboardEvent extends dom.window.Event { key: string; constructor(type: string, init: EventInit & { key?: string } = {}) { super(type, init); this.key = init.key ?? ""; } }
Object.assign(dom.window, { KeyboardEvent: ShimKeyboardEvent });
const originalFetch = globalThis.fetch;

let root: Root | undefined, host: HTMLDivElement | undefined;
const puts: ChatSettings[] = [];

function entry(over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
	return {
		id: "glm-local", provider: "custom:llama", name: "GLM local", reasoning: true,
		input: ["text"], supportedLevels: ["off", "low", "medium"], maxTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, ...over,
	};
}

function fixture(chatSettings: ChatSettings | undefined) {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/models") return Response.json({ models: [entry()], defaults: null } as ModelCatalogResponse);
		if (url === "/api/settings") return Response.json({ settings: { models: null } });
		if (url.endsWith("/settings") && init?.method === "PUT") {
			puts.push(JSON.parse(String(init.body)) as ChatSettings);
			return Response.json({ settings: JSON.parse(String(init.body)) as ChatSettings });
		}
		if (url.includes("/api/chats/")) return Response.json({ id: "c1", settings: chatSettings });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
}

async function mount(chatId = "c1") {
	host = document.createElement("div");
	document.body.append(host);
	// DYNAMIC imports (the dictation-picker harness rule): react-dom must
	// evaluate AFTER the DOM globals above exist. A static import hoists over
	// the assignment, so react-dom boots with no window → canUseDOM=false →
	// its legacy input-event polyfill (attachEvent on a linkedom node) crashes.
	const { createRoot } = await import("react-dom/client");
	const { ModelControl } = await import("../components/model-picker.tsx");
	root = createRoot(host);
	await act(async () => root?.render(<ModelControl chatId={chatId} />));
	await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function openThinkingMenu() {
	const button = document.querySelector('[data-testid="stats-thinking"]') as HTMLElement;
	await act(async () => button.click());
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
	puts.length = 0;
});

describe("the thinking ceiling field (chat Thinking menu)", () => {
	it("rides for a custom-endpoint model with thinking ON, and NOT when the level is off", async () => {
		fixture({ model: { provider: "custom:llama", id: "glm-local" }, thinkingLevel: "low" });
		await mount();
		await openThinkingMenu();
		assert.ok(document.querySelector('[data-testid="thinking-max-tokens"]'), "the ceiling input rides when thinking is on");

		// Switch the level to off → the field must disappear (a budget with
		// thinking off would be a lie, and it has no effect anywhere).
		const offRow = [...document.querySelectorAll('[data-testid="thinking-menu"] button')].find((b) => /off/i.test(b.textContent ?? ""));
		assert.ok(offRow, "the menu carries the off row");
		await act(async () => (offRow as HTMLElement).click());
		await act(async () => new Promise((r) => setTimeout(r, 0)));
		await openThinkingMenu();
		assert.equal(document.querySelector('[data-testid="thinking-max-tokens"]'), null, "off hides the ceiling field — decoration is a lie");
	});

	it("Enter writes the number; blur commits too (the owner's 'non mi fa scrivere' fix)", async () => {
		fixture({ model: { provider: "custom:llama", id: "glm-local" }, thinkingLevel: "low" });
		await mount();

		const type = async (value: string) => {
			// The dictation-picker harness pattern: the prototype's value setter
			// (bypasses any framework write-back tracker) + a plain bubbling Event.
			const el = document.querySelector('[data-testid="thinking-max-tokens"]') as HTMLInputElement;
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
			await act(async () => { el.dispatchEvent(new window.Event("input", { bubbles: true })); });
		};
		const pressEnter = async () => {
			const el = document.querySelector('[data-testid="thinking-max-tokens"]') as HTMLInputElement;
			const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(enter, { key: "Enter" });
			await act(async () => { el.dispatchEvent(enter); });
		};
		const blur = async () => {
			// React maps the NATIVE focusout to onBlur — a raw "blur" event would
			// never reach the handler.
			const el = document.querySelector('[data-testid="thinking-max-tokens"]') as HTMLInputElement;
			await act(async () => { el.dispatchEvent(new window.Event("focusout", { bubbles: true })); });
		};

		// Type + Enter → the number LANDS in the session record.
		await openThinkingMenu();
		await type("8192");
		await pressEnter();
		assert.deepEqual(puts.at(-1), { model: { provider: "custom:llama", id: "glm-local" }, thinkingLevel: "low", thinkingMaxTokens: 8192 }, "Enter lands the number");

		// The commit closed the menu (saveChat's setOpen(null)); reopening shows
		// the LANDED value as the field's seed — the record, not a ghost draft.
		await openThinkingMenu();
		assert.equal((document.querySelector('[data-testid="thinking-max-tokens"]') as HTMLInputElement).value, "8192", "the reopened field shows the stored number");

		// Blur commit (click-away): a DIFFERENT number, typed and blurred.
		await type("6144");
		await blur();
		assert.equal(puts.at(-1)?.thinkingMaxTokens, 6144, "blur commits the typed number — clicking away must not eat it");

		// Blur on an ALREADY-committed value must NOT re-write (no double PUT).
		await openThinkingMenu();
		const writesBefore = puts.length;
		await blur();
		assert.equal(puts.length, writesBefore, "blurring a stored value is a no-op");

		// Clearing commits the unset state (empty = endpoint default / pi's ladder).
		await type("");
		await blur();
		assert.equal(puts.at(-1)?.thinkingMaxTokens, undefined, "empty commits the unset ceiling");
	});

	it("the stored ceiling rides every pick (replace-whole): picking off keeps the number in the record even while the field hides", async () => {
		fixture({ model: { provider: "custom:llama", id: "glm-local" }, thinkingLevel: "low", thinkingMaxTokens: 8192 });
		await mount();
		await openThinkingMenu();
		const offRow = [...document.querySelectorAll('[data-testid="thinking-menu"] button')].find((b) => /off/i.test(b.textContent ?? ""));
		await act(async () => (offRow as HTMLElement).click());
		assert.equal(puts.at(-1)?.thinkingMaxTokens, 8192, "cycling to off does not wipe the configured ceiling");
	});

	it("a NON-custom provider never shows the field (it has no effect there)", async () => {
		fixture({ model: { provider: "openrouter", id: "other" }, thinkingLevel: "low" });
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/models") return Response.json({ models: [entry({ provider: "openrouter", id: "other" })], defaults: null } as ModelCatalogResponse);
			if (url === "/api/settings") return Response.json({ settings: { models: null } });
			return Response.json({ id: "c1", settings: { model: { provider: "openrouter", id: "other" }, thinkingLevel: "low" } });
		}) as typeof fetch;
		await mount();
		await openThinkingMenu();
		assert.equal(document.querySelector('[data-testid="thinking-max-tokens"]'), null, "no ceiling field for a non-custom model");
	});
});


