import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import ext from "./when.ts";

process.env.TZ = "UTC";
initTheme("dark");
const W = 40;
const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
const bgOf = (s: string) => s.match(/\x1b\[48;2;\d+;\d+;\d+m/)?.[0];

// Minimal pi harness: capture handlers, fire session_start with our entries.
function boot(entries: any[]) {
	const handlers: Record<string, Function> = {};
	ext({ on: (n: string, f: Function) => (handlers[n] = f) } as any);
	handlers.session_start({}, { sessionManager: { getEntries: () => entries } });
}
const msg = (role: string, content: any, timestamp: number) => ({ type: "message", message: { role, content, timestamp } });
const T = (h: number, m: number) => Date.UTC(2026, 0, 1, h, m);

test("user box: stamp on top padding, keeps bg; duplicate texts get their own times", () => {
	boot([msg("user", "hi", T(9, 5)), msg("user", "hi", T(10, 7))]);
	const a = new UserMessageComponent("hi").render(W);
	const b = new UserMessageComponent("hi").render(W);
	assert.equal(strip(a[0]).trim(), "09:05");
	assert.equal(strip(b[0]).trim(), "10:07");
	assert.ok(bgOf(a[0]) && bgOf(a[0]) === bgOf(a[1]), "stamp line bg matches box bg");
	assert.equal(strip(a[0]).length, W, "stamp line spans the full width");
});

test("assistant: stamp from message timestamp, no bg", () => {
	boot([]);
	const c = new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: T(12, 0) } as any,
		false,
	);
	const lines = c.render(W);
	assert.equal(strip(lines[0]).trim(), "12:00");
	assert.equal(bgOf(lines[0]), undefined);
});

test("tool box: leading spacer stays an empty gap, stamp inside box, bg follows completion", () => {
	boot([msg("assistant", [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } }], T(11, 9))]);
	const ui = { requestRender() {} } as any;
	const c = new ToolExecutionComponent("bash", "call1", { command: "ls" }, undefined, undefined, ui, process.cwd());
	const pending = c.render(W);
	assert.equal(pending[0], "", "spacer line untouched");
	assert.equal(strip(pending[1]).trim(), "11:09");
	assert.ok(bgOf(pending[1]));
	c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	const done = c.render(W);
	assert.equal(strip(done[1]).trim(), "11:09");
	assert.equal(bgOf(done[1]), bgOf(done[2]), "stamp bg matches the box's current bg");
	assert.notEqual(bgOf(done[1]), bgOf(pending[1]), "bg changed on completion");
});

test("stale ctx never crashes render", () => {
	const handlers: Record<string, Function> = {};
	ext({ on: (n: string, f: Function) => (handlers[n] = f) } as any);
	handlers.session_start({}, { sessionManager: { getEntries: () => { throw new Error("stale"); } } });
	assert.doesNotThrow(() => new UserMessageComponent("x").render(W));
});
