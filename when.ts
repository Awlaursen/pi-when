import {
	AssistantMessageComponent,
	type ExtensionAPI,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences. Enough to test "is this line blank".
const stripTerminalSequences = (s: string) =>
	s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

// Draws the message time (HH:MM) in the top-right corner of every user, assistant and tool box.
// Pi has no hook for decorating built-in message boxes, so this wraps the three components'
// render(): line 0 of each is a blank padding/spacer line, and the stamp is painted onto it.

const OSC133_START = "\x1b]133;A\x07";
const STAMP_DELTA = 60; // brightness offset of the stamp text from the box bg; raise for more contrast
const STAMP_NO_BG = 100; // gray level (0-255) when the line has no bg (assistant, terminal-black); raise for more contrast
// Process-global state so /reload (which re-evaluates this module) swaps the entry source instead
// of leaving the prototype patch bound to a stale ctx, and never wraps render() twice.
const state: {
	patched: boolean;
	getEntries: () => any[];
	stamps: WeakMap<object, string>;
	claimed: Set<number>; // user-message timestamps already shown, so repeated texts get their own time
} = ((globalThis as any)[Symbol.for("pi-when")] ??= {
	patched: false,
	getEntries: () => [],
	stamps: new WeakMap(),
	claimed: new Set(),
});
const { stamps, claimed } = state;
const getEntries = () => {
	try {
		return state.getEntries();
	} catch {
		return []; // stale ctx during session replacement/reload → fall back to "now"
	}
};

const fmt = (ms: number) =>
	new Date(ms).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
const userText = (m: any): string =>
	typeof m.content === "string"
		? m.content
		: m.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

function timestampFor(c: any): number {
	if (c instanceof AssistantMessageComponent)
		return (c as any).lastMessage?.timestamp ?? Date.now();
	const entries = getEntries();
	if (c instanceof ToolExecutionComponent) {
		for (const e of entries) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			if (
				e.message.content.some(
					(p: any) => p.type === "toolCall" && p.id === (c as any).toolCallId,
				)
			)
				return e.message.timestamp;
		}
		return Date.now();
	}
	let last: number | undefined;
	for (const e of entries) {
		if (
			e.type !== "message" ||
			e.message.role !== "user" ||
			!userText(e.message).includes(c.text)
		)
			continue;
		last = e.message.timestamp as number;
		if (!claimed.has(last)) {
			claimed.add(last);
			return last;
		}
	}
	return last ?? Date.now();
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
		const hasBg = (l: string | undefined) =>
			l !== undefined && l.includes("\x1b[48");
		let i = -1;
		if (blank(lines[0]) && hasBg(lines[0])) i = 0;
		else if (blank(lines[0]) && blank(lines[1]) && hasBg(lines[1])) i = 1;
		else if (blank(lines[0])) i = 0;
		if (i < 0) return lines;
		let stamp = stamps.get(this);
		if (!stamp) stamps.set(this, (stamp = fmt(timestampFor(this))));
		// Reuse the line's own background SGR (tools swap box/bg on completion, so component fields lie);
		// spacer gaps have none and stay gaps.
		const bgCode = lines[i].match(/\x1b\[(?:[0-9;]*;)?48[;m][0-9;]*m?/)?.[0];
		const bg = bgCode ? (s: string) => `${bgCode}${s}\x1b[49m` : undefined;
		// Text = the box's own bg, nudged in brightness (truecolor only); otherwise plain dim.
		const rgb = bgCode?.match(/48;2;(\d+);(\d+);(\d+)/);
		const fg = rgb
			? `\x1b[38;2;${rgb
					.slice(1, 4)
					.map((c) => Math.min(255, Math.max(0, Number(c) + STAMP_DELTA)))
					.join(";")}m`
			: `\x1b[38;2;${STAMP_NO_BG};${STAMP_NO_BG};${STAMP_NO_BG}m`;
		const prefix = lines[i].startsWith(OSC133_START) ? OSC133_START : "";
		const body =
			" ".repeat(Math.max(0, width - stamp.length - 1)) +
			`${fg}${stamp}\x1b[39;22m `;
		lines[i] = prefix + (bg ? bg(body) : body);
		return lines;
	};
}
state.patched = true;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		state.getEntries = () => ctx.sessionManager.getEntries();
		claimed.clear();
	});
	pi.on("session_shutdown", () => {
		state.getEntries = () => [];
	});
}
