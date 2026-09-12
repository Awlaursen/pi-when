# pi-when

A [Pi](https://pi.dev/) extension that paints each message's time (`HH:MM`) into the top-right corner of its own box — user, assistant and tool boxes alike. No extra rows, no session entries, nothing sent to the model.

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

The stamp is drawn on the box's existing top padding line, so layout doesn't change. Its color is the box's own background nudged brighter, so it stays discreet on every theme and follows a tool box when it turns green/red on completion.

## Where the time comes from

- **User message**: the session entry's recorded timestamp. Repeated identical prompts each get their own time.
- **Assistant message**: the message's own timestamp.
- **Tool box**: the timestamp of the assistant message that issued the tool call.

Times are rendered in your locale, 24-hour.

## Tuning

Two constants at the top of `when.ts`:

- `STAMP_DELTA` (default `60`): brightness offset from the box background. Raise for more contrast.
- `STAMP_NO_BG` (default `100`): gray level for lines without a background (assistant messages on a black terminal).

## How it works (and the known limit)

Pi has no hook for decorating its built-in message boxes, so `pi-when` wraps `render()` on `UserMessageComponent`, `AssistantMessageComponent` and `ToolExecutionComponent` and paints onto the first blank line that already carries the box background. It never touches a content line, survives `/reload` without double-patching, and falls back to "now" instead of throwing if the session context is stale.

Because it patches exported classes, a Pi release that restructures those components may simply stop showing stamps. Nothing else breaks.

## Development

```
npm install
npm run typecheck
npm test          # node --test, no framework
pi -e ./when.ts   # try it in a session
```

MIT
