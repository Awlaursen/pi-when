import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

// Draws the message time in the top-right corner of every user, assistant and tool box.
// Pi has no hook for decorating built-in message boxes, so this wraps the three components'
// render() and paints the stamp onto the box's blank top padding line.

// Tuning. Edits need a Pi restart, not just /reload: the render wrapper from the first module
// evaluation stays installed and keeps its own copies. The format is read through the shared
// state below instead, so when.json edits do apply on /reload.
const STAMP_DELTA = 60; // brightness offset of the stamp text from the box bg (darker on light bgs)
const STAMP_NO_BG = 100; // gray level (0-255) for bg-less lines on truecolor terminals (assistant)

const OSC133_START = "\x1b]133;A\x07";
// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences. Enough to test "is this line blank".
const stripTerminalSequences = (s: string) =>
	s.replace(
		/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g,
		"",
	);
const BG_SGR = /\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/; // truecolor or 256-color background

const pad2 = (n: number) => String(n).padStart(2, "0");

// A strftime subset, deliberately C-locale: the stamp sits in a fixed-width corner, so weekday and
// month names stay ASCII and the same width whatever the machine's locale is. Unknown tokens are
// left as written, so a typo shows up in the corner instead of vanishing.
const DAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const MONTHS =
	"January February March April May June July August September October November December".split(
		" ",
	);
const TOKENS: Record<string, (d: Date) => string> = {
	"%": () => "%",
	a: (d) => DAYS[d.getDay()].slice(0, 3),
	A: (d) => DAYS[d.getDay()],
	b: (d) => MONTHS[d.getMonth()].slice(0, 3),
	B: (d) => MONTHS[d.getMonth()],
	d: (d) => pad2(d.getDate()),
	F: (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
	H: (d) => pad2(d.getHours()),
	I: (d) => pad2(d.getHours() % 12 || 12),
	M: (d) => pad2(d.getMinutes()),
	m: (d) => pad2(d.getMonth() + 1),
	p: (d) => (d.getHours() < 12 ? "AM" : "PM"),
	R: (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
	S: (d) => pad2(d.getSeconds()),
	T: (d) =>
		`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
	Y: (d) => String(d.getFullYear()),
	y: (d) => pad2(d.getFullYear() % 100),
};

/** strftime(3) subset: %aAbBdFHIMmpRSTYy and %%. */
export const strftime = (d: Date, format: string): string =>
	format.replace(/%(.)/g, (whole, c: string) => TOKENS[c]?.(d) ?? whole);

export type WhenConfig = { format: string; formatOlder: string };
/** Short today, weekday-qualified once a message is not from today. */
const DEFAULTS: WhenConfig = { format: "%H:%M", formatOlder: "%a %H:%M" };

// A project's .pi/when.json is untrusted: Pi may be started in a repository written by someone
// else, JSON escapes such as \u001b become real control bytes, and the stamp is written straight
// to the terminal. Without this a repository could inject CSI/OSC sequences into every box --
// spoofing the display, or writing the clipboard with OSC 52. No timestamp format needs C0, DEL
// or C1, so they are stripped from every source rather than only from the untrusted one.
const sanitize = (s: string) => s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
const str = (v: unknown, fallback: string) =>
	typeof v === "string" ? sanitize(v) : fallback;
const obj = (v: unknown): any => (v && typeof v === "object" ? v : {});

/**
 * defaults <- ~/.pi/when.json <- <cwd>/.pi/when.json <- PI_WHEN_FORMAT[_OLDER].
 * A non-string value falls back rather than throwing: this runs inside render(), and a bad config
 * file must not take the TUI down with it.
 */
export function resolveConfig(
	home: unknown,
	project: unknown,
	env: Record<string, string | undefined>,
): WhenConfig {
	const merged = { ...DEFAULTS, ...obj(home), ...obj(project) };
	const format = str(env.PI_WHEN_FORMAT, str(merged.format, DEFAULTS.format));
	// formatOlder null means "one format everywhere"; a bare PI_WHEN_FORMAT overrides both slots.
	// Tested against undefined, not truthiness: PI_WHEN_FORMAT="" is a valid way to ask for no
	// stamp at all, and must silence older messages too rather than restoring their file format.
	const older =
		merged.formatOlder === null || env.PI_WHEN_FORMAT !== undefined
			? format
			: str(merged.formatOlder, DEFAULTS.formatOlder);
	return { format, formatOlder: str(env.PI_WHEN_FORMAT_OLDER, older) };
}

const readJson = (path: string): unknown => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined; // absent, unreadable or malformed: fall back, never crash the TUI
	}
};
const loadConfig = (): WhenConfig => {
	let project: unknown;
	try {
		// process.cwd() itself throws once the directory is deleted under a long-running session,
		// before readJson's own guard can catch anything.
		project = readJson(join(process.cwd(), ".pi", "when.json"));
	} catch {
		project = undefined;
	}
	return resolveConfig(
		readJson(join(homedir(), ".pi", "when.json")),
		project,
		process.env,
	);
};

// Process-global state so /reload (which re-evaluates this module) swaps the entry source instead
// of leaving the prototype patch bound to a stale ctx, and never wraps render() twice.
type State = {
	patched: boolean;
	config: WhenConfig;
	getEntries: (() => any[]) | undefined; // undefined = no session bound (startup, between sessions)
	stamps: WeakMap<object, string>;
	claimed: Set<number>; // user-message timestamps already shown, so repeated texts get their own time
};
const state: State = ((globalThis as any)[Symbol.for("pi-when")] ??= {
	patched: false,
	config: DEFAULTS,
	getEntries: undefined,
	stamps: new WeakMap(),
	claimed: new Set(),
} satisfies State);

// Re-read on every module evaluation so /reload applies when.json edits. Cached stamps were
// rendered with the old format, so drop them when it changes.
const loaded = loadConfig();
// Optional access on a non-optional field: a 0.1.x process still holds a state object with no
// config, and /reload keeps that object, so a plain dereference would throw here and take the
// extension down before it could register.
if (
	state.config?.format !== loaded.format ||
	state.config?.formatOlder !== loaded.formatOlder
) {
	state.config = loaded;
	state.stamps = new WeakMap();
}

/** Entries of the bound session, or undefined when none is bound / the ctx is stale. */
const getEntries = (): any[] | undefined => {
	try {
		return state.getEntries?.();
	} catch {
		return undefined;
	}
};


const fmt = (ms: number) => {
	const d = new Date(ms);
	const today = d.toDateString() === new Date().toDateString();
	return strftime(d, today ? state.config.format : state.config.formatOlder);
};
/** Message timestamp in ms; older/foreign sessions may only have the entry's ISO timestamp. */
const entryTime = (e: any): number | undefined => {
	if (typeof e.message?.timestamp === "number") return e.message.timestamp;
	const t = Date.parse(e.timestamp);
	return Number.isNaN(t) ? undefined : t;
};
const userText = (m: any): string =>
	typeof m.content === "string"
		? m.content
		: m.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

/** Resolved timestamp, or undefined when not (yet) known so the caller does not cache a guess. */
function timestampFor(c: any): number | undefined {
	if (c instanceof AssistantMessageComponent) {
		const t = (c as any).lastMessage?.timestamp;
		return typeof t === "number" ? t : undefined;
	}
	const entries = getEntries();
	if (!entries) return undefined;
	if (c instanceof ToolExecutionComponent) {
		const id = (c as any).toolCallId;
		for (const e of entries) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			if (e.message.content.some((p: any) => p.type === "toolCall" && p.id === id))
				return entryTime(e);
		}
		return undefined;
	}
	// User message: match by text. Pi rebuilds the chat (new components) on compaction, tree
	// navigation and some settings toggles without a session event, so if every match is already
	// claimed, treat that as a rebuild, reset, and try once more.
	const scan = (): { hit: number | undefined; found: boolean } => {
		let found = false;
		for (const e of entries) {
			if (
				e.type !== "message" ||
				e.message.role !== "user" ||
				!userText(e.message).includes(c.text)
			)
				continue;
			const t = entryTime(e);
			if (t === undefined) continue;
			found = true;
			if (!state.claimed.has(t)) {
				state.claimed.add(t);
				return { hit: t, found };
			}
		}
		return { hit: undefined, found };
	};
	const first = scan();
	if (first.hit !== undefined || !first.found) return first.hit;
	state.claimed.clear();
	return scan().hit;
}

for (const C of [
	UserMessageComponent,
	AssistantMessageComponent,
	ToolExecutionComponent,
]) {
	if (state.patched) break;
	const orig = C.prototype.render;
	C.prototype.render = function (this: any, width: number) {
		const lines = [...orig.call(this, width)];
		// Target: the box's top padding line (blank, has a bg) if it is line 0 or 1 (tools start with a
		// spacer gap), else a blank line 0 (assistant messages have no box). Never touch a content line.
		const blank = (l: string | undefined) =>
			l !== undefined && stripTerminalSequences(l).trim() === "";
		const hasBg = (l: string | undefined) => l !== undefined && BG_SGR.test(l);
		let i = -1;
		if (blank(lines[0]) && hasBg(lines[0])) i = 0;
		else if (blank(lines[0]) && blank(lines[1]) && hasBg(lines[1])) i = 1;
		else if (blank(lines[0])) i = 0;
		if (i < 0) return lines;
		// Cache only resolved times; a guess ("now") is re-resolved on the next frame.
		let stamp = state.stamps.get(this);
		if (!stamp) {
			const t = timestampFor(this);
			if (t === undefined) stamp = fmt(Date.now());
			else state.stamps.set(this, (stamp = fmt(t)));
		}
		if (width < stamp.length + 1) return lines;
		// Reuse the line's own background SGR (tools swap box/bg on completion, so component fields lie);
		// spacer gaps have none and stay gaps.
		const bgCode = lines[i].match(BG_SGR)?.[0];
		const bg = bgCode ? (s: string) => `${bgCode}${s}\x1b[49m` : undefined;
		// Text color: the bg nudged toward contrast on truecolor; fixed gray for bg-less truecolor
		// lines; plain dim where the terminal is not truecolor (256-color bg).
		const rgb = bgCode?.match(/48;2;(\d+);(\d+);(\d+)/);
		let fg: string;
		if (rgb) {
			const ch = rgb.slice(1, 4).map(Number);
			const delta =
				ch.reduce((a, b) => a + b, 0) / 3 > 128 ? -STAMP_DELTA : STAMP_DELTA;
			fg = `\x1b[38;2;${ch.map((c) => Math.min(255, Math.max(0, c + delta))).join(";")}m`;
		} else if (bgCode) {
			fg = "\x1b[2m";
		} else {
			fg = `\x1b[38;2;${STAMP_NO_BG};${STAMP_NO_BG};${STAMP_NO_BG}m`;
		}
		const prefix = lines[i].startsWith(OSC133_START) ? OSC133_START : "";
		const body =
			" ".repeat(width - stamp.length - 1) + `${fg}${stamp}\x1b[39;22m `;
		lines[i] = prefix + (bg ? bg(body) : body);
		return lines;
	};
}
state.patched = true;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		state.getEntries = () => ctx.sessionManager.getEntries();
		state.claimed.clear();
	});
	pi.on("session_compact", () => state.claimed.clear());
	pi.on("session_tree", () => state.claimed.clear());
	pi.on("session_shutdown", () => {
		state.getEntries = undefined;
	});
}
