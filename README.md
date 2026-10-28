# warm-compact

A mod for Claude Code that compacts a large idle session a few minutes before
its prompt cache expires, so that coming back to it is cheap.

## Why not the built-in idle compaction

Claude Code 2.1.290 and later has its own `idleCompaction`. The mod differs:

- **Works in the desktop app.** The built-in one runs only in a terminal; in
  the Code tab of the Claude desktop app it never fired for us in a month.
- **A summary made for coming back.** The note keeps the goal, the next step,
  rejected options, exact paths, commands and numbers (see [The summary](#the-summary)).
- **Each summary saved to a file**, so you can check what was kept or hand it
  to another session.
- **No compaction while the usage limit is used up**, and none after the
  computer slept, when the cache is already cold.
- **Under your control.** `/warm-compact now`, `off` and `on` per session, the
  idle time and size threshold in settings, and a journal of every decision.

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
- **A question left unanswered.** A question card (`AskUserQuestion`) keeps
  the turn open until you answer it, so no turn end starts the count. When
  the model puts one up, a line in the session shows the time it will be
  removed; if it is still unanswered then, the mod removes it and compacts,
  with the same checks as above. A card stays up at least 5 minutes: one that
  appears late, behind a long tool of the same answer, is removed 5 minutes
  after it appeared, or not watched at all when that leaves less than a minute
  before `cutoffMinutes`, since the compaction must start before it.
  While another tool of the same turn still runs, the card stays, since ending
  the turn would stop that tool too. The question goes into the summary in
  full (header, options with their descriptions, one or several answers) as
  an open question, and into a line in the session: answer it in a message.
  To the model, the removed card reads as a tool call that did not complete.
  A card answered in time is left as it was, and so is a question another
  plugin asks.

### The summary

The mod gives the summary its own instructions: write a note for continuing
the work, with the goal, what is done, what is left and the next step, the
files touched, decisions and permissions with their reasons, rejected options
and why (briefly), the exact paths, file names, commands, commits, identifiers
and numbers needed to continue and verify the work (not rounded, leaving out
intermediate and repeated ones), open background work, what was not
verified, and dates. Your `noteHint` is added to the end.

Each summary the mod produces is also saved as a Markdown file under
`~/.claude/plugins/data/warm-compact/summaries/` (or under
`$CLAUDE_CONFIG_DIR` when it is set), named by time and session id. The log
line names the file. Use it to check what the compaction kept, to add what it
missed, or to hand the note to another session. The files stay on your
machine with no time limit: the mod never deletes them. A summary takes
10-30 KB, so even daily compactions add only some megabytes a year; delete
old files by hand if you like. The first line of each file is an HTML comment
with the session, time and sizes. If the file cannot be written within five
seconds, the compaction stands and only the file is missing.

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

A record with `outcome: "noted"` marks a quiet exit that left the session
without a timer where one was expected: a turn of the main loop that started
before the previous one ended, a turn that ended without arming the timer, a
timer that found a turn or another compaction under way, a question card left
up at its time (the cache was cold, a used-up limit, running agents, another
tool of the turn still running, or the turn could not be ended). These go to the store
alone, with no line in the transcript, and the same one is kept once until a
timer is armed again. The
expected exits are not recorded: a context under `minTokens`, the mod off in
the session, a headless run, a turn with no model request.

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
- A session is compacted only after some surface has shown it once: a run
  that never drew is taken for a headless one. A hidden session keeps the
  mark through a plugin reload, but not through a restart of the app; it
  is compacted again once you open it.
- Only a question card of the main loop is removed, not one a subagent asks.
  A plugin reload while a card is open drops its watch: that card waits for
  your answer, as it did before 0.2.5.

## Development

Tested on Claude Code 2.1.308.

```
claude plugin validate --strict .
claude plugin test .
```

MIT License.
