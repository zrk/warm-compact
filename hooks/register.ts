import type { EngineInterface, Register, SessionCompactResult, SessionRateLimit, Timer } from 'claude-code';
import { cachePercent, clockTime, instructions, settings, t, tokens, type Config, type MessageKey } from './text.ts';

// A one-hour prompt cache lapses an hour after the last request that read or
// wrote it. The main loop's last model request starts the count; when the
// session has idled for `idleMinutes` since, with a large enough context, the
// mod compacts it while the cache is still warm, so the summary reads the
// conversation at the cache price and the next return starts small.

const VERSION = '0.1.0';
const ARMED = { plugin: 'warm-compact', key: 'armed' } as const;
const LOG_KEY = 'log';
const LOG_LIMIT = 500;
const BUSY_AGENTS = ['pending', 'running', 'waiting'];
// A compaction that has not reported back by then is given up on, so a call
// that never settles cannot switch the mod off for the rest of the session.
const STALE_MS = 10 * 60_000;

type Outcome = 'compacted' | 'skipped' | 'failed';

export type LogEntry = {
  sessionId: string;
  at: string;
  outcome: Outcome;
  reason: string;
  manual: boolean;
  idleMinutes: number;
  tokensBefore?: number;
  tokensAfter?: number;
  cacheShare?: number;
  summaryInput?: number;
  summaryOutput?: number;
};

type Compacting = {
  token: number;
  sessionId: string;
  startedAt: number;
  idleMinutes: number;
  tokensBefore?: number;
  manual: boolean;
  // The last request the cache was refreshed by: the cutoff counts from it.
  since: number;
  // The instructions this mod sent: they tell its own /compact from someone else's.
  note: string;
  // Set when the main loop sent a request or someone else compacted after the
  // mod queued /compact: the queued command then has nothing left to do.
  overtaken?: string;
};

let cfg: Config = settings();
const say = (key: MessageKey, vars?: Record<string, string | number>) => t(cfg, key, vars);

// Bumped on every disarm, so a timer or an arm still awaiting its reads can
// tell it was overtaken.
let generation = 0;
let timer: Timer | undefined;
let dueAt: number | undefined;
// The request the armed timer counts from, as kept in $.state.
let armedSince: number | undefined;
let lastRequestAt: number | undefined;
let working = false;
let compacting: Compacting | undefined;
// Whether `$.session.compact()` works here: unknown in a terminal, false in an
// SDK session (the desktop app), which compacts only inside a /compact turn.
let direct: boolean | undefined;

function disarm() {
  generation += 1;
  timer?.cancel();
  timer = undefined;
  dueAt = undefined;
  armedSince = undefined;
}

function forget($: EngineInterface) {
  return $.state.set(ARMED, null).catch(() => {});
}

async function isOff($: EngineInterface, sessionId: string) {
  return (await $.store.get(`off:${sessionId}`)) === true;
}

async function record($: EngineInterface, entry: LogEntry, line: string) {
  try {
    const saved = await $.store.get(LOG_KEY);
    const log = Array.isArray(saved) ? (saved as LogEntry[]) : [];
    await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_LIMIT));
  } finally {
    await $.ui.log(line);
  }
}

function entry(c: Pick<Compacting, 'sessionId' | 'idleMinutes' | 'manual' | 'tokensBefore'>, at: number, outcome: Outcome, reason: string): LogEntry {
  return { sessionId: c.sessionId, at: new Date(at).toISOString(), outcome, reason, manual: c.manual, idleMinutes: c.idleMinutes, tokensBefore: c.tokensBefore };
}

async function finish($: EngineInterface, c: Compacting, result: SessionCompactResult | undefined, failure?: string) {
  // A late answer of an attempt given up on must not close a newer one.
  if (compacting !== c) return;
  compacting = undefined;
  // The history was replaced or the attempt is over: nothing to wait out until the next request.
  if (!c.overtaken) lastRequestAt = undefined;
  const now = await $.clock.now();
  if (result && result.skip === undefined) {
    const share = cachePercent(result.usage);
    const before = result.tokensBefore ?? c.tokensBefore;
    const e: LogEntry = {
      ...entry(c, now, 'compacted', c.manual ? 'manual' : 'idle'),
      tokensBefore: before,
      tokensAfter: result.tokensAfter,
      cacheShare: share,
      summaryInput: result.usage ? result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens : undefined,
      summaryOutput: result.usage?.output_tokens,
    };
    const cache = share === undefined ? '' : say('cacheShare', { pct: share });
    await record($, e, say('compacted', { time: clockTime(now), idle: c.idleMinutes, before: tokens(before), after: tokens(result.tokensAfter), cache }));
  } else if (result) {
    await record($, entry(c, now, 'skipped', `vetoed: ${result.skip}`), say('vetoed', { reason: result.skip }));
  } else {
    const reason = (failure || 'no compaction seen').slice(0, 300);
    await record($, entry(c, now, 'failed', reason), say('failed', { reason }));
  }
}

/** The engine's refusal of the direct call in an SDK session (the desktop app). */
export function isHeadlessRefusal(err: unknown) {
  return /headless|SDK session/i.test(String((err as Error)?.message ?? err));
}

/** A rate-limit window that is used up and not known to have reset: until it does, requests are refused or billed as extra usage. */
export function usedUp(limits: readonly SessionRateLimit[], now: number): SessionRateLimit | undefined {
  // The reading is the last API response's: past its reset time the window is fresh again.
  return (limits ?? []).find(w => w.percentUsed >= 100 && !(Date.parse(w.resetsAt ?? '') <= now));
}

/** Why the attempt should not compact any more: the cache went cold while it waited. */
function lateReason(c: Compacting, now: number): string | undefined {
  return !c.manual && now - c.since > cfg.cutoffMs ? 'late: the cache went cold while waiting' : undefined;
}

/** The timer's work: checks again that compacting is due and worth it, then compacts. */
async function fire($: EngineInterface, token: number, sessionId: string, since: number, manual: boolean) {
  const stale = (now: number) => token !== generation || working || (compacting !== undefined && now - compacting.startedAt < STALE_MS);
  const start = await $.clock.now();
  if (stale(start)) return;
  const base = { sessionId, idleMinutes: Math.round((start - since) / 60_000), manual };
  // A skip ends this idle period; the state is cleared only while no newer timer owns it.
  const skip = async (reason: string, line: string, tokensBefore?: number) => {
    if (token === generation) await forget($);
    await record($, entry({ ...base, tokensBefore }, start, 'skipped', reason), line);
  };
  if ((await $.session.id()) !== sessionId) return;
  if (!manual && start - since > cfg.cutoffMs) {
    await skip('late', say('skipLate', { idle: base.idleMinutes }));
    return;
  }
  const { context, rateLimits } = await $.session.usage();
  const size = context.tokens;
  if (!manual && (size ?? 0) < cfg.minTokens) {
    await skip('small', say('skipSmall', { tokens: tokens(size), min: tokens(cfg.minTokens) }), size);
    return;
  }
  // By hand or not: the summary request would be refused until the reset, or billed as extra usage.
  const limit = usedUp(rateLimits, start);
  if (limit) {
    await skip('limited', say('skipLimited', { kind: limit.kind }), size);
    return;
  }
  if (!manual) {
    const busy = (await $.agent.list()).filter(a => BUSY_AGENTS.includes(a.status));
    if (busy.length) {
      await skip('agents', say('skipAgents', { n: busy.length }), size);
      return;
    }
  }
  // The reads above took time: the cache must still be warm and no turn started.
  const now = await $.clock.now();
  if (stale(now)) return;
  if (!manual && now - since > cfg.cutoffMs) {
    await skip('late', say('skipLate', { idle: Math.round((now - since) / 60_000) }));
    return;
  }
  const idleMinutes = Math.round((now - since) / 60_000);
  const note = instructions(cfg, clockTime(now), idleMinutes, manual);
  const attempt: Compacting = { token, sessionId, startedAt: now, idleMinutes, tokensBefore: size, manual, since, note };
  compacting = attempt;
  timer = undefined;
  dueAt = undefined;
  armedSince = undefined;
  // Cleared before compacting: a reload meanwhile must not start a second one.
  await forget($);
  const ours = () => compacting === attempt;
  if (!ours() || token !== generation || working) {
    if (ours()) compacting = undefined;
    return;
  }
  try {
    if (direct !== false) {
      try {
        const late = lateReason(attempt, await $.clock.now());
        if (late) {
          await finish($, attempt, { skip: late });
          return;
        }
        const result = await $.session.compact({ instructions: note });
        direct = true;
        await finish($, attempt, result);
        return;
      } catch (err) {
        if (!isHeadlessRefusal(err)) throw err;
        direct = false;
      }
      if (!ours() || token !== generation || working) {
        if (ours()) compacting = undefined;
        return;
      }
    }
    // An SDK session compacts inside a turn: run /compact as if typed. It is
    // queued until the session is idle; the compaction passes through this
    // module's `session.compact` hook, which records it.
    const output = await $.command.run({ command: 'compact', args: note });
    await finish($, attempt, undefined, `/compact ran without compacting: ${output.text ?? '(no output)'}`);
  } catch (err) {
    await finish($, attempt, undefined, String((err as Error)?.message ?? err));
  }
}

function schedule($: EngineInterface, sessionId: string, since: number, now: number) {
  const token = generation;
  dueAt = since + cfg.idleMs;
  armedSince = since;
  timer = $.clock.after(Math.max(0, dueAt - now), () => {
    void fire($, token, sessionId, since, false).catch(() => {});
  });
}

/** At the end of a main-loop turn: arms the timer when the context is large enough. */
async function arm($: EngineInterface) {
  disarm();
  const token = generation;
  const since = lastRequestAt;
  if (since === undefined) return;
  // Headless runs (-p, an SDK script, a bot) draw nowhere: leave them alone.
  if (!(await $.session.surfaces()).length) return;
  const sessionId = await $.session.id();
  if (await isOff($, sessionId)) return;
  const { context } = await $.session.usage();
  const now = await $.clock.now();
  if (token !== generation) return;
  if ((context.tokens ?? 0) < cfg.minTokens) {
    await forget($);
    return;
  }
  schedule($, sessionId, since, now);
  // Kept for a reload of the module, which drops its timers.
  await $.state.set(ARMED, { sessionId, lastRequestAt: since });
  // Overtaken while writing: a turn.start may have cleared the state before this
  // write landed, or a newer arm written its own; leave what the newer one owns.
  if (token !== generation) {
    if (armedSince === undefined) await forget($);
    else await $.state.set(ARMED, { sessionId, lastRequestAt: armedSince }).catch(() => {});
  }
}

/** After a reload: arms again for what is left since this session's last request. */
async function rearm($: EngineInterface) {
  disarm();
  const token = generation;
  const { value } = await $.state.get(ARMED);
  const sessionId = await $.session.id();
  const now = await $.clock.now();
  if (token !== generation || !value || value.sessionId !== sessionId) return;
  if (await isOff($, sessionId)) return;
  if (token !== generation) return;
  lastRequestAt = value.lastRequestAt;
  schedule($, sessionId, value.lastRequestAt, now);
}

async function statusText($: EngineInterface) {
  const sessionId = await $.session.id();
  const off = await isOff($, sessionId);
  const now = await $.clock.now();
  let armed: string;
  if (off) armed = say('notArmed', { why: say('offHere') });
  else if (compacting && now - compacting.startedAt < STALE_MS) armed = say('compactingNow');
  else if (working) armed = say('working');
  else if (dueAt !== undefined) {
    const { context } = await $.session.usage();
    armed = say('armedAt', { time: clockTime(dueAt), tokens: tokens(context.tokens) });
  } else if (lastRequestAt === undefined) armed = say('notArmed', { why: say('noRequest') });
  else {
    const { context } = await $.session.usage();
    armed = say('notArmed', { why: say('small', { tokens: tokens(context.tokens), min: tokens(cfg.minTokens) }) });
  }
  const lines = [say('status', { version: VERSION, state: say(off ? 'off' : 'on'), idle: cfg.idleMs / 60_000, cutoff: cfg.cutoffMs / 60_000, min: tokens(cfg.minTokens), armed })];
  const saved = await $.store.get(LOG_KEY);
  const mine = (Array.isArray(saved) ? (saved as LogEntry[]) : []).filter(e => e.sessionId === sessionId).slice(-5);
  if (!mine.length) lines.push(say('none'));
  else {
    lines.push(say('recent'));
    for (const e of mine) {
      const outcome = say(e.outcome === 'compacted' ? 'outcomeCompacted' : e.outcome === 'skipped' ? 'outcomeSkipped' : 'outcomeFailed');
      const sizes = e.tokensAfter === undefined ? tokens(e.tokensBefore) : `${tokens(e.tokensBefore)} → ${tokens(e.tokensAfter)}`;
      lines.push(`- ${clockTime(Date.parse(e.at))} ${outcome} (${e.reason}), ${e.idleMinutes} min, ${sizes}`);
    }
  }
  return lines.join('\n');
}

async function control($: EngineInterface, raw: string): Promise<{ text: string }> {
  const args = raw.trim().toLowerCase() || 'status';
  const sessionId = await $.session.id();
  if (args === 'off') {
    await $.store.set(`off:${sessionId}`, true);
    // A /compact still queued does not run after the mod said it is off.
    if (compacting && !compacting.overtaken) compacting.overtaken = 'turned off';
    disarm();
    await forget($);
    return { text: say('turnedOff') };
  }
  if (args === 'on') {
    await $.store.delete(`off:${sessionId}`);
    if (!working && !compacting) await arm($);
    return { text: say('turnedOn') };
  }
  if (args === 'now') {
    const now = await $.clock.now();
    if (working || (compacting && now - compacting.startedAt < STALE_MS)) return { text: say('busy') };
    disarm();
    const token = generation;
    const since = lastRequestAt ?? now;
    // Outside this hook: a compaction cannot run inside the command's own dispatch.
    timer = $.clock.after(1000, () => {
      void fire($, token, sessionId, since, true).catch(() => {});
    });
    return { text: say('nowScheduled') };
  }
  if (args !== 'status') return { text: say('commands') };
  return { text: await statusText($) };
}

export const register: Register = (on, options) => {
  cfg = settings(options);

  // Also fires when the module is reloaded (/reload-plugins, an update, an
  // options change), which drops the timer: pick up where the last request left off.
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    // Not a terminal REPL: an SDK host (the desktop app) or -p, which refuse the direct call.
    direct = e.isInteractive && e.surface === 'terminal' ? undefined : false;
    try {
      await $.command.register({ name: 'warm-compact', description: say('commandDescription'), argumentHint: 'status | now | off | on', immediate: true });
      await rearm($);
    } catch {}
    return result;
  });

  on('command.run', { command: 'warm-compact' }, ($, e) => control($, e.args));

  on('prompt.submit', async ($, e, next) => {
    // Desktop may send a custom slash command as client-composed text.
    // Only a standalone command from the human-facing transport is local.
    const local = /^\/warm-compact(?:[ \t]+([^\r\n]*))?[ \t]*$/.exec(e.text);
    if (local && !e.attachments?.length && ['composer', 'sdk', 'bridge'].includes(e.origin.kind)) {
      try {
        return { drop: (await control($, local[1] ?? 'status')).text };
      } catch (err) {
        return { drop: `warm-compact: ${String((err as Error)?.message ?? err)}` };
      }
    }
    return next(e);
  });

  // The cache's hour runs from the start of the last request, not from the end
  // of the answer. The summarizer runs as a fork of its own (agentId set).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now().catch(() => undefined);
      if (now !== undefined) lastRequestAt = now;
      // The main loop is busy again: a /compact still queued has nothing to do.
      if (compacting && !compacting.overtaken) compacting.overtaken = 'a turn ran first';
    }
    return yield* next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      disarm();
      working = true;
      await forget($);
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const armed = generation;
    const result = await next(e);
    // A turn that started meanwhile owns the state now.
    if (e.agentId !== undefined || armed !== generation) return result;
    working = false;
    // Never let arming the timer break the turn.
    await arm($).catch(() => {});
    return result;
  });

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e);
    // Another hook may have added to the instructions on the way: the mod's text stays inside.
    const attempt = compacting !== undefined && e.instructions?.includes(compacting.note) ? compacting : undefined;
    if (attempt) {
      const reason = attempt.overtaken ?? lateReason(attempt, await $.clock.now().catch(() => attempt.startedAt));
      if (reason) {
        const skipped = { skip: reason };
        await finish($, attempt, skipped).catch(() => {});
        return skipped;
      }
    }
    const result = await next(e);
    if (attempt) {
      // This module's own /compact in an SDK session arrives here.
      await finish($, attempt, result).catch(() => {});
    } else if (result.skip === undefined) {
      // Someone else compacted (/compact, the threshold): the history was replaced.
      if (compacting) compacting.overtaken = 'compacted by someone else first';
      disarm();
      lastRequestAt = undefined;
      await forget($);
    }
    return result;
  });

  on('session.end', async ($, e, next) => {
    // Also a /clear: the conversation ends and the process goes on under a new id.
    disarm();
    lastRequestAt = undefined;
    working = false;
    compacting = undefined;
    await forget($);
    return next(e);
  });
};
