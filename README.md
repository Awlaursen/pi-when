# pi-when

A [Pi](https://pi.dev/) extension that paints each message's time (`HH:MM`) into the top-right corner of its own box, for user, assistant and tool boxes alike. It stays out of the layout and out of the model context: the stamp is drawn on a line that already exists, and it is display-only.

```
pi install npm:pi-when
```

## How it looks

```
┌──────────────────────────────────────── 14:32 ┐
│ > fix the flaky test                          │
└───────────────────────────────────────────────┘

                                           14:32
Sure, the race is in `setup()`…

┌──────────────────────────────────────── 14:33 ┐
│ bash  npm test                                │
│ ✔ 12 passed                                   │
└───────────────────────────────────────────────┘
```

The stamp is drawn on the box's existing top padding line, so layout doesn't change. Its color is the box's own background nudged toward contrast (brighter on dark themes, darker on light ones), so it stays discreet and follows a tool box when it turns green/red on completion. On 256-color terminals it uses the terminal's dim attribute instead.

## Timestamp sources

- **User message**: the session entry's recorded timestamp. Repeated identical prompts each get their own time.
- **Assistant message**: the message's own timestamp.
- **Tool box**: the timestamp of the assistant message that issued the tool call.

Times are shown as 24-hour `HH:MM` in your local time zone. A tool box created while its assistant message is still streaming has no recorded time yet, so it shows the current time until the next redraw, then the recorded one.

## Tuning

Edit these constants at the top of `when.ts`, then restart Pi (`/reload` keeps the first-loaded values):

- `STAMP_DELTA` (default `60`): contrast offset from the box background. Raise for more contrast.
- `STAMP_NO_BG` (default `100`): gray level for lines without a background (assistant messages on a black terminal).

## How it works (and the known limit)

Pi has no hook for decorating its built-in message boxes, so `pi-when` wraps `render()` on `UserMessageComponent`, `AssistantMessageComponent` and `ToolExecutionComponent` and paints onto the first blank line that has the box background. Content lines are left alone. `/reload` is safe: the patch is applied once per process, and a stale session context falls back to "now".

Because it patches exported classes, a Pi release that restructures those components may stop showing stamps. Everything else in Pi keeps working. After `pi remove pi-when`, restart Pi to drop the patch.

## Development

```
npm install
npm run typecheck
npm test          # node --test, no framework; needs Node 22.18+ for type stripping
pi -e ./when.ts   # try it in a session
```

MIT
