import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import ext, { resolveConfig, strftime } from "./when.ts";

process.env.TZ = "UTC";
initTheme("dark");

// Pin the format so the rendering tests below do not depend on the machine's when.json, and so a
// fixed past timestamp still renders as plain HH:MM. The adaptive default has its own test.
const state = (globalThis as any)[Symbol.for("pi-when")];
state.config = { format: "%H:%M", formatOlder: "%H:%M" };
const withConfig = (config: any, fn: () => void) => {
	const previous = state.config;
	state.config = config;
	try {
		fn();
	} finally {
		state.config = previous;
	}
};
const W = 40;
const strip = (s: string) =>
	s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
const bgOf = (s: string) => s.match(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/)?.[0];
const fgOf = (s: string) => s.match(/\x1b\[38;2;\d+;\d+;\d+m|\x1b\[2m/)?.[0];

// Minimal pi harness: capture handlers, fire session_start with our entries.
function boot(entries: any[]) {
	const handlers: Record<string, Function> = {};
	ext({ on: (n: string, f: Function) => (handlers[n] = f) } as any);
	handlers.session_start({}, { sessionManager: { getEntries: () => entries } });
	return handlers;
}
const msg = (
	role: string,
	content: any,
	timestamp: number | undefined,
	iso?: string,
) => ({
	type: "message",
	timestamp: iso,
	message: { role, content, timestamp },
});
const T = (h: number, m: number) => Date.UTC(2026, 0, 1, h, m);
const now = () => fmt(Date.now());
const fmt = (ms: number) => {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const tool = (id = "call1") =>
	new ToolExecutionComponent(
		"bash",
		id,
		{ command: "ls" },
		undefined,
		{ name: "bash", description: "", parameters: {} } as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);

test("user box: stamp on top padding, keeps bg; duplicate texts get their own times", () => {
	boot([msg("user", "hi", T(9, 5)), msg("user", "hi", T(10, 7))]);
	const a = new UserMessageComponent("hi").render(W);
	const b = new UserMessageComponent("hi").render(W);
	assert.equal(strip(a[0]).trim(), "09:05");
	assert.equal(strip(b[0]).trim(), "10:07");
	assert.ok(
		bgOf(a[0]) && bgOf(a[0]) === bgOf(a[1]),
		"stamp line bg matches box bg",
	);
	assert.equal(strip(a[0]).length, W, "stamp line spans the full width");
});

test("chat rebuild without a session event: duplicates still get distinct times", () => {
	boot([msg("user", "hi", T(9, 5)), msg("user", "hi", T(10, 7))]);
	new UserMessageComponent("hi").render(W);
	new UserMessageComponent("hi").render(W);
	// Pi rebuilt the chat (e.g. settings toggle): new components, no session_start.
	const a = new UserMessageComponent("hi").render(W);
	const b = new UserMessageComponent("hi").render(W);
	assert.equal(strip(a[0]).trim(), "09:05");
	assert.equal(strip(b[0]).trim(), "10:07");
});

test("assistant: stamp from message timestamp, no bg", () => {
	boot([]);
	const c = new AssistantMessageComponent(
		{
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			timestamp: T(12, 0),
		} as any,
		false,
	);
	const lines = c.render(W);
	assert.equal(strip(lines[0]).trim(), "12:00");
	assert.equal(bgOf(lines[0]), undefined);
});

test("tool box: leading spacer stays an empty gap, stamp inside box, bg follows completion", () => {
	boot([
		msg(
			"assistant",
			[
				{
					type: "toolCall",
					id: "call1",
					name: "bash",
					arguments: { command: "ls" },
				},
			],
			T(11, 9),
		),
	]);
	const c = tool();
	const pending = c.render(W);
	assert.equal(pending[0], "", "spacer line untouched");
	assert.equal(strip(pending[1]).trim(), "11:09");
	assert.ok(bgOf(pending[1]));
	c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	const done = c.render(W);
	assert.equal(strip(done[1]).trim(), "11:09");
	assert.equal(
		bgOf(done[1]),
		bgOf(done[2]),
		"stamp bg matches the box's current bg",
	);
	assert.notEqual(bgOf(done[1]), bgOf(pending[1]), "bg changed on completion");
});

test("a repainted frame reuses the stamped line instead of rebuilding it", () => {
	boot([
		msg(
			"assistant",
			[{ type: "toolCall", id: "call1", name: "bash", arguments: {} }],
			T(11, 9),
		),
	]);
	const c = tool();
	const paints = () => (globalThis as any)[Symbol.for("pi-when")].paints as number;
	const first = c.render(W);
	const before = paints();
	assert.equal(c.render(W)[1], first[1]);
	assert.equal(paints(), before, "same frame again: no repaint");
	assert.notEqual(c.render(W - 10)[1], first[1]);
	assert.equal(paints(), before + 1, "width change repaints");
	c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	c.render(W - 10);
	assert.equal(paints(), before + 2, "box change repaints");
});

test("unresolved time is not cached: shows now, then the real time once entries exist", () => {
	const entries: any[] = [];
	boot(entries);
	const c = tool("late");
	assert.equal(strip(c.render(W)[1]).trim(), now());
	entries.push(
		msg(
			"assistant",
			[{ type: "toolCall", id: "late", name: "bash", arguments: {} }],
			T(3, 4),
		),
	);
	assert.equal(strip(c.render(W)[1]).trim(), "03:04");
});

test("missing message.timestamp falls back to the entry ISO time, never 'Invalid Date'", () => {
	boot([msg("user", "old", undefined, "2026-01-01T07:08:00.000Z")]);
	const lines = new UserMessageComponent("old").render(W);
	assert.equal(strip(lines[0]).trim(), "07:08");
});

test("stamp color: brighter on dark bg, darker on light bg, dim on 256-color bg", () => {
	boot([]);
	// The wrapper reads the bg from the rendered line, so give the component's Box a chosen bg.
	const fake = (bg: string) => {
		const c = new UserMessageComponent("x");
		c.render(W); // builds children
		const box = (c as any).children[0];
		box.setBgFn((s: string) => `${bg}${s}\x1b[49m`);
		return c.render(W);
	};
	assert.equal(fgOf(fake("\x1b[48;2;40;40;50m")[0]), "\x1b[38;2;100;100;110m");
	assert.equal(
		fgOf(fake("\x1b[48;2;235;235;245m")[0]),
		"\x1b[38;2;175;175;185m",
	);
	assert.equal(fgOf(fake("\x1b[48;5;236m")[0]), "\x1b[2m");
});

test("too narrow: line left untouched", () => {
	boot([msg("user", "hi", T(9, 5))]);
	const c = new UserMessageComponent("hi");
	const lines = c.render(4);
	assert.equal(strip(lines[0]).trim(), "");
});

test("strftime: every token, literals kept, unknown token left as written", () => {
	const d = new Date(Date.UTC(2026, 8, 19, 14, 32, 7)); // Saturday 2026-09-19
	assert.equal(strftime(d, "%H:%M:%S"), "14:32:07");
	assert.equal(strftime(d, "%I%p"), "02PM");
	assert.equal(strftime(new Date(Date.UTC(2026, 8, 19, 9, 0)), "%I %p"), "09 AM");
	assert.equal(strftime(d, "%a %A"), "Sat Saturday");
	assert.equal(strftime(d, "%b %B"), "Sep September");
	assert.equal(strftime(d, "%Y-%m-%d %y"), "2026-09-19 26");
	assert.equal(strftime(d, "%F %T"), "2026-09-19 14:32:07");
	assert.equal(strftime(d, "%R"), "14:32");
	assert.equal(strftime(d, "at %R %%"), "at 14:32 %");
	assert.equal(strftime(d, "%q"), "%q", "unknown token is visible, not silently dropped");
	assert.equal(strftime(d, "%%H"), "%H", "%% does not consume the next token");
});

test("resolveConfig: defaults, project over home, env over both, null and junk handled", () => {
	const noEnv = {};
	assert.deepEqual(resolveConfig(undefined, undefined, noEnv), {
		format: "%H:%M",
		formatOlder: "%a %H:%M",
	});
	assert.deepEqual(resolveConfig({ format: "%T" }, undefined, noEnv), {
		format: "%T",
		formatOlder: "%a %H:%M",
	});
	assert.equal(
		resolveConfig({ format: "%T" }, { format: "%R" }, noEnv).format,
		"%R",
		"project wins over home",
	);
	assert.deepEqual(
		resolveConfig({ format: "%T" }, { format: "%R" }, { PI_WHEN_FORMAT: "%F" }),
		{ format: "%F", formatOlder: "%F" },
		"a bare PI_WHEN_FORMAT overrides both slots",
	);
	assert.equal(
		resolveConfig(undefined, undefined, {
			PI_WHEN_FORMAT: "%F",
			PI_WHEN_FORMAT_OLDER: "%a",
		}).formatOlder,
		"%a",
	);
	assert.deepEqual(resolveConfig({ formatOlder: null }, undefined, noEnv), {
		format: "%H:%M",
		formatOlder: "%H:%M",
		}, "null means one format everywhere");
	assert.deepEqual(resolveConfig({ format: 5 }, "not an object", noEnv), {
		format: "%H:%M",
		formatOlder: "%a %H:%M",
	}, "junk falls back instead of throwing inside render");
	assert.deepEqual(
		resolveConfig(undefined, undefined, { PI_WHEN_FORMAT: "" }),
		{ format: "", formatOlder: "" },
		"an empty PI_WHEN_FORMAT is a setting, not an absent variable",
	);
});

test("untrusted project config cannot inject terminal control sequences", () => {
	// A repository someone else wrote ships .pi/when.json; JSON escapes arrive as real bytes and the
	// stamp is written straight to the terminal. OSC 52 would otherwise set the system clipboard.
	const hostile = {
		format: "\u001b]52;c;aGVsbG8=\u0007%H:%M",
		formatOlder: "\u001b[2J%H:%M\u007f",
	};
	const got = resolveConfig(undefined, hostile, {});
	assert.equal(got.format, "]52;c;aGVsbG8=%H:%M");
	assert.equal(got.formatOlder, "[2J%H:%M");
	for (const f of [got.format, got.formatOlder])
		assert.ok(
			!/[\u0000-\u001F\u007F-\u009F]/.test(f),
			"no control byte survives into a format",
		);
	// The same applies to the environment and the home file, so one rule covers every source.
	assert.equal(
		resolveConfig({ format: "\u001b[31m%R" }, undefined, {}).format,
		"[31m%R",
	);
});

test("/reload from 0.1.x: state object without a config field does not crash", () => {
	// 0.1.x stored no config under Symbol.for("pi-when"), and /reload reuses that object.
	const legacy = { ...state };
	delete (legacy as any).config;
	assert.doesNotThrow(() => {
		if (
			(legacy as any).config?.format !== "%H:%M" ||
			(legacy as any).config?.formatOlder !== "%a %H:%M"
		)
			(legacy as any).config = { format: "%H:%M", formatOlder: "%a %H:%M" };
	});
	assert.deepEqual((legacy as any).config, {
		format: "%H:%M",
		formatOlder: "%a %H:%M",
	});
});

test("adaptive default: short today, weekday-qualified once the message is older", () => {
	withConfig({ format: "%H:%M", formatOlder: "%a %H:%M" }, () => {
		const today = new Date();
		today.setHours(8, 15, 0, 0);
		boot([msg("user", "fresh", today.getTime()), msg("user", "stale", T(9, 5))]);
		assert.equal(
			strip(new UserMessageComponent("fresh").render(W)[0]).trim(),
			"08:15",
		);
		assert.equal(
			strip(new UserMessageComponent("stale").render(W)[0]).trim(),
			"Thu 09:05", // 2026-01-01
		);
	});
});

test("stale ctx never crashes render", () => {
	const handlers: Record<string, Function> = {};
	ext({ on: (n: string, f: Function) => (handlers[n] = f) } as any);
	handlers.session_start(
		{},
		{
			sessionManager: {
				getEntries: () => {
					throw new Error("stale");
				},
			},
		},
	);
	assert.doesNotThrow(() => new UserMessageComponent("x").render(W));
});
