# warm-compact

A mod for Claude Code that compacts a large idle session a few minutes before
its prompt cache expires, so that coming back to it is cheap.

Claude Code keeps a one-hour prompt cache. If you return to a large session
after more than an hour, the whole context is written to the cache again at
twice the input price, while reading it from a warm cache costs 0.1. The mod
compacts a large idle session while the cache is still warm: the summary reads
the conversation from the cache, and your next return starts from a small
context.

The mod assumes the one-hour cache of a Claude subscription. Where the cache
lives five minutes (some API key, Bedrock or Vertex setups), the summary would
read a cold context and cost more than doing nothing: do not install it there.

It works in sessions that are drawn somewhere: the Code tab of the Claude
desktop app, an interactive terminal session, or a connected client. Headless
runs (`claude -p`, SDK scripts, bots without a surface) are never touched.

## Install

In a terminal session:

```
/plugin install warm-compact --marketplace ivbala1/warm-compact
```

Answer `y` to add the marketplace and pick the user scope. New sessions get
the mod on their own; in a session that is already open, send
`/reload-plugins`, then `/warm-compact status` to see it loaded.

## How it works

- **The count starts at the last model request.** The mod measures time from
  the start of the last model request of the main loop.
- **Compaction.** After `idleMinutes` of silence, if the context is at least
  `minTokens`, the session is compacted.
- **Cold cache is skipped.** If the timer fires later than `cutoffMinutes`
  after the last request (for example the computer was asleep), the cache is
  already cold and the mod does nothing.
- **A used-up limit is skipped.** While a usage-limit window stands at 100%
  and has not reset, the mod does not compact, by hand or not: the summary
  request would be refused until the reset, or billed as extra usage if that
  is on. A session that waits for the reset is left as it is.
- **Subagents.** While subagents run, the mod skips.
- **Cancelling.** Any new turn, `/clear`, or a compaction done by someone else
  cancels the timer.
- **Reload.** A plugin reload arms the timer again for the time that is left.
- **Two ways to compact.** In the desktop app (an SDK session) the direct call
  is refused, so the mod runs `/compact` as a queued command. In a terminal it
  calls the compaction directly.
- **Your message wins.** If a turn runs or someone else compacts before the
  queued `/compact` starts, the mod drops its compaction: the cache is warm
  again or the context is small already.

### The summary

The mod gives the summary its own instructions: write a note for continuing
the work, with the goal, what is done, what is left and the next step, the
files touched, decisions and permissions with their reasons, open background
work, what was not verified, and dates. Your `noteHint` is added to the end.

## Commands

| Command | Effect |
| --- | --- |
| `/warm-compact status` | Version, session and state |
| `/warm-compact now` | Compact at once, ignoring idle time and size; refused while a turn runs, skipped while the usage limit is used up |
| `/warm-compact off` | Turn the mod off in this session |
| `/warm-compact on` | Turn it back on in this session |

`off` and `on` apply to the current session only.

## Settings

Set them with `/plugin configure warm-compact@warm-compact`, or in
`settings.json`; unset options keep the defaults below:

```json
{
  "pluginConfigs": {
    "warm-compact@warm-compact": {
      "options": { "idleMinutes": 52, "cutoffMinutes": 57, "minTokens": 200000, "language": "en", "noteHint": "" }
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `idleMinutes` | 52 | Minutes after the last model request before compaction; keep it a few minutes under the one-hour cache |
| `cutoffMinutes` | 57 | A timer that fires later than this after the last request skips, because the cache is cold already |
| `minTokens` | 200000 | Context size below which a cold re-read is cheap and the session is left as it is |
| `language` | `en` | `en` or `ru`: the mod's messages and its instructions to the summary |
| `noteHint` | empty | Extra text added to the summary instructions, for example what else to keep |

## Journal

The mod writes one line to the transcript for every decision (compacted or
skipped, and why). It also keeps the last 500 records in the plugin store
under the key `log`:

```json
{ "sessionId": "", "at": "", "outcome": "", "reason": "", "manual": false,
  "idleMinutes": 0, "tokensBefore": 0, "tokensAfter": 0, "cacheShare": 0,
  "summaryInput": 0, "summaryOutput": 0 }
```

## Built-in idle compaction

Claude Code 2.1.290 and later has its own `idleCompaction` setting (about 54
minutes, 200K tokens and more, documented for the terminal). In a terminal
both may run. If you want only this mod, set `"idleCompaction": false`.

## Limits

- The computer has to be awake and the app or terminal session open; the mod
  does not start a closed app.
- The mod can only shorten the context, it does not make the summary
  perfect: details not written into the note may be lost, as with any
  compaction.

## Development

Tested on Claude Code 2.1.308.

```
claude plugin validate --strict .
claude plugin test .
```

MIT License.
