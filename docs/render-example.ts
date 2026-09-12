// Renders the README example with Pi's real components (dark theme, truecolor) and writes
// docs/example.svg. Convert with: rsvg-convert docs/example.svg -o docs/example.png
// Run: COLORTERM=truecolor node docs/render-example.ts
import { writeFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	initTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import ext from "../when.ts";

const W = 64;
const T = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime();
const entries = [
	{ type: "message", message: { role: "user", content: "fix the flaky test", timestamp: T(14, 32) } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
			timestamp: T(14, 33),
		},
	},
];
const handlers: Record<string, Function> = {};
ext({ on: (n: string, f: Function) => (handlers[n] = f) } as any);
initTheme("dark");
handlers.session_start({}, { sessionManager: { getEntries: () => entries } });

const tool = new ToolExecutionComponent(
	"bash",
	"c1",
	{ command: "npm test" },
	undefined,
	{ name: "bash", description: "", parameters: {} } as any,
	{ requestRender() {} } as any,
	process.cwd(),
);
tool.updateResult({ content: [{ type: "text", text: "12 passing" }], isError: false });
const lines = [
	...new UserMessageComponent("fix the flaky test").render(W),
	...new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text: "The race is in `setup()`. Running the suite." }], timestamp: T(14, 32) } as any,
		false,
	).render(W),
	...tool.render(W),
	"",
];

// Minimal SGR -> SVG. Handles what Pi's theme emits: 38;2/48;2 truecolor, 38;5/48;5 (256), 1, 2, 3, 22, 23, 39, 49, 0.
const CW = 9.6, LH = 22, PAD = 16, FONT = "Noto Sans Mono, DejaVu Sans Mono, monospace";
// NBSP: SVG renderers collapse or trim ordinary spaces even with xml:space="preserve".
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "\u00a0");
const c256 = (n: number) => {
	if (n < 16) return ["#000", "#c00", "#0c0", "#cc0", "#00c", "#c0c", "#0cc", "#ccc", "#666", "#f66", "#6f6", "#ff6", "#66f", "#f6f", "#6ff", "#fff"][n];
	if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
	const i = n - 16, s = [0, 95, 135, 175, 215, 255];
	return `rgb(${s[Math.floor(i / 36)]},${s[Math.floor(i / 6) % 6]},${s[i % 6]})`;
};
let svg = "";
lines.forEach((line, row) => {
	let fg: string | undefined, bg: string | undefined, dim = false, italic = false, col = 0, run = "";
	const y = PAD + row * LH;
	const flush = () => {
		if (!run) return;
		const x = PAD + col * CW;
		if (bg) svg += `<rect x="${x}" y="${y}" width="${run.length * CW}" height="${LH}" fill="${bg}"/>`;
		const style = `${fg ? `fill="${fg}"` : ""} ${dim ? 'opacity="0.55"' : ""} ${italic ? 'font-style="italic"' : ""}`;
		svg += `<text x="${x}" y="${y + 16}" xml:space="preserve" ${style}>${esc(run)}</text>`;
		col += run.length; run = "";
	};
	const re = /\x1b\[([0-9;]*)m|\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]/g;
	let last = 0, m: RegExpExecArray | null;
	while ((m = re.exec(line))) {
		run += line.slice(last, m.index); last = re.lastIndex;
		if (m[1] === undefined) continue;
		flush();
		const p = m[1].split(";").map(Number);
		for (let i = 0; i < p.length; i++) {
			const n = p[i];
			if (n === 0) { fg = bg = undefined; dim = italic = false; }
			else if (n === 2) dim = true; else if (n === 3) italic = true;
			else if (n === 22) dim = false; else if (n === 23) italic = false;
			else if (n === 39) fg = undefined; else if (n === 49) bg = undefined;
			else if ((n === 38 || n === 48) && (p[i + 1] === 2 || p[i + 1] === 5)) {
				const v = p[i + 1] === 2 ? `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})` : c256(p[i + 2]);
				if (n === 38) fg = v; else bg = v;
				i += p[i + 1] === 2 ? 4 : 2;
			}
			else if (n >= 30 && n <= 37) fg = c256(n - 30); else if (n >= 90 && n <= 97) fg = c256(n - 90 + 8);
		}
	}
	run += line.slice(last); flush();
});
const width = PAD * 2 + W * CW, height = PAD * 2 + lines.length * LH;
writeFileSync(
	new URL("./example.svg", import.meta.url),
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${FONT}" font-size="16"><rect width="100%" height="100%" fill="#1e1e1e"/><g fill="#d4d4d4">${svg}</g></svg>\n`,
);
console.log(`docs/example.svg: ${lines.length} lines`);
