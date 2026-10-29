import type { EngineInterface, Register, SessionCompacted, SessionCompactResult, SessionRateLimit, Timer } from 'claude-code';
import { cachePercent, clockTime, instructions, questionLine, questionNote, settings, t, tokens, type Config, type MessageKey } from './text.ts';

// A one-hour prompt cache lapses an hour after the last request that read or
// wrote it. The main loop's last model request starts the count; when the
// session has idled for `idleMinutes` since, with a large enough context, the
// mod compacts it while the cache is still warm, so the summary reads the
// conversation at the cache price and the next return starts small.

const VERSION = '0.2.7';
const ARMED = { plugin: 'warm-compact', key: 'armed' } as const;
const DRAWN = { plugin: 'warm-compact', key: 'drawn' } as const;
const REQUEST = { plugin: 'warm-compact', key: 'request' } as const;
const LOG_KEY = 'log';
const LOG_LIMIT = 500;
const BUSY_AGENTS = ['pending', 'running', 'waiting'];
// A compaction that has not reported back by then is given up on, so a call
// that never settles cannot switch the mod off for the rest of the session.
const STALE_MS = 10 * 60_000;
// How far usage() may read under the last request before the two are told apart in the log.
const GAP_TOKENS = 10_000;
// A timer this late past its time is taken for lost, not for one slowed by a busy host.
const LOST_MS = 2 * 60_000;

// 'noted': a quiet exit that left the session without a timer, kept for diagnosis.
type Outcome = 'compacted' | 'skipped' | 'failed' | 'noted';

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
  summaryFile?: string;
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
  // The removed cards' questions the note carries.
  question?: string;
  // Set when the main loop sent a request or someone else compacted after the
  // mod queued /compact: the queued command then has nothing left to do.
  overtaken?: string;
};

// The AskUserQuestion cards a turn of the main loop waits on: the turn stays open
// until each is answered, so its end never arms the timer; the watch removes them.
type Watch = {
  turnId: string;
  sessionId: string;
  // The request that put the cards up: the cache's hour counts from it.
  since: number;
  shownAt: number;
  removeAt: number;
  // The cards still unanswered, by tool_use_id: each one's questions.
  cards: Map<string, readonly unknown[]>;
  timer?: Timer;
};

// A card stays up at least this long: one that went up late, behind a long tool
// of the same answer, does not vanish at once.
const CARD_MIN_MS = 5 * 60_000;
// A card is removed at least this long before the cutoff: the compaction its
// removal starts must begin before the cutoff, which skips it as late.
const CARD_MARGIN_MS = 60_000;

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
// What that request read, as the API reported it: told beside usage() when the two disagree.
let lastRequestTokens: number | undefined;
let working = false;
let compacting: Compacting | undefined;
// Whether a surface has listed this session at least once: a hidden session stays
// armed, a headless run that never drew does not; quiet exits are kept for drawn sessions alone.
// Kept in $.state too, so a reload while the session is hidden keeps it.
let drawn = false;
// Whether this module found the session's own mark in $.state at its start: a reload, not a first load.
let reloaded = false;
// A reload found a turn of the main loop under way: its end is due in this module.
let awaitingEnd = false;
// The quiet exits kept since the last armed timer: each is kept once.
const quietKept = new Set<string>();
// The main loop's turn that started last, and a watch on it that notes a turn not ending.
let currentTurn: string | undefined;
let turnWatch: Timer | undefined;
// Appends to the log run one after another, so two writers do not overwrite each other.
let appending: Promise<unknown> = Promise.resolve();
// Whether `$.session.compact()` works here: unknown in a terminal, false in an
// SDK session (the desktop app), which compacts only inside a /compact turn.
let direct: boolean | undefined;
// The cards watched now, and the model's other tool calls of the main loop still
// running (tool_use_id → turn): ending the turn would stop them too.
let watch: Watch | undefined;
const running = new Map<string, string | undefined>();
// The model's cards not watched when they went up (tool_use_id → questions): a
// session first drawn later, when a client joins, watches them then.
const unwatched = new Map<string, unknown>();
// The questions of the cards removed, for the summary: kept until a compaction
// that carried them succeeds, a model request moves the conversation on, or the session ends.
let openQuestion: string | undefined;

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

/** Reads whether a surface draws the session now, and keeps the first yes in $.state. */
async function lookDrawn($: EngineInterface) {
  if ((await $.session.surfaces()).length === 0 || drawn) return;
  await markDrawn($);
}

/** Marks the session drawn and keeps the mark in $.state; true when it was not drawn before. */
async function markDrawn($: EngineInterface) {
  if (drawn) return false;
  drawn = true;
  // A failed write costs only a reload while hidden: the timer is armed all the same.
  try {
    await $.state.set(DRAWN, { sessionId: await $.session.id() });
  } catch {}
  return true;
}

/**
 * Keeps the main loop's last request in $.state, and whether its turn ended:
 * a reload that lands as the turn ends counts from it. Without `at` the saved
 * one is kept as it is; a failed write costs only that reload.
 */
async function keepRequest($: EngineInterface, at: number | undefined, ended: boolean) {
  try {
    const sessionId = await $.session.id();
    if (at === undefined) at = (await savedRequest($, sessionId))?.at;
    if (at !== undefined) await $.state.set(REQUEST, { sessionId, at, ended });
  } catch {}
}

async function savedRequest($: EngineInterface, sessionId: string) {
  const { value } = await $.state.get(REQUEST);
  return value && value.sessionId === sessionId ? value : undefined;
}

function forgetRequest($: EngineInterface) {
  return $.state.set(REQUEST, null).catch(() => {});
}

async function isOff($: EngineInterface, sessionId: string) {
  return (await $.store.get(`off:${sessionId}`)) === true;
}

/** Appends to the log; `unless` reads the log first and keeps the entry out when it says so. */
function append($: EngineInterface, entry: LogEntry, unless?: (log: LogEntry[]) => boolean) {
  const run = appending.then(async () => {
    const saved = await $.store.get(LOG_KEY);
    const log = Array.isArray(saved) ? (saved as LogEntry[]) : [];
    if (unless?.(log)) return;
    await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_LIMIT));
  });
  appending = run.catch(() => {});
  return run;
}

async function record($: EngineInterface, entry: LogEntry, line: string) {
  try {
    await append($, entry);
  } finally {
    await $.ui.log(line);
  }
}

/**
 * A quiet exit that leaves a drawn session without a timer where one was due:
 * kept in the log alone, without a line in the session, each once until a timer
 * is armed again, and not again while it is the session's last entry (a reload
 * forgets what was kept). The expected exits (a small context, off, a newer
 * turn taking over) are not kept. `always` keeps one of a session that never
 * drew, which is otherwise left alone.
 */
async function quiet($: EngineInterface, reason: string, extra: { sessionId?: string; tokensBefore?: number; manual?: boolean; always?: boolean } = {}) {
  if (!drawn && !extra.always) return;
  let key: string | undefined;
  try {
    const id = extra.sessionId ?? (await $.session.id().catch(() => 'unknown'));
    key = `${id}|${reason}`;
    if (quietKept.has(key)) return;
    // Taken before the writes, so a second call meanwhile is kept out; a failed write gives it back.
    quietKept.add(key);
    const now = await $.clock.now();
    const idleMinutes = lastRequestAt === undefined ? 0 : Math.round((now - lastRequestAt) / 60_000);
    const repeated = (log: LogEntry[]) => {
      const last = [...log].reverse().find(e => e.sessionId === id);
      return last?.outcome === 'noted' && last.reason === reason;
    };
    await append($, entry({ sessionId: id, idleMinutes, manual: extra.manual ?? false, tokensBefore: extra.tokensBefore }, now, 'noted', reason), repeated);
  } catch {
    if (key !== undefined) quietKept.delete(key);
  }
}

function errorText(err: unknown) {
  return String((err as Error)?.message ?? err).slice(0, 200);
}

function entry(c: Pick<Compacting, 'sessionId' | 'idleMinutes' | 'manual' | 'tokensBefore'>, at: number, outcome: Outcome, reason: string): LogEntry {
  return { sessionId: c.sessionId, at: new Date(at).toISOString(), outcome, reason, manual: c.manual, idleMinutes: c.idleMinutes, tokensBefore: c.tokensBefore };
}

// Saving the summary never holds up the compaction's result for longer than this.
const SAVE_MS = 5_000;

/** Where the summaries are kept: beside the engine's own data, one file per compaction. */
async function summaryDir($: EngineInterface): Promise<string | undefined> {
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await home($));
  return base && `${base.replace(/[\\/]+$/, '')}/plugins/data/warm-compact/summaries`;
}

async function home($: EngineInterface): Promise<string | undefined> {
  const dir = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'));
  return dir ? `${dir.replace(/[\\/]+$/, '')}/.claude` : undefined;
}

/** Keeps the summary as a file, to check or hand on later; a failure only loses the file. */
async function saveSummary($: EngineInterface, c: Compacting, at: number, result: SessionCompacted): Promise<string | undefined> {
  // From core the summary comes first, then the messages it kept.
  const first = result.messages[0];
  const summary = first?.role === 'user' ? first.text.trim() : '';
  if (!summary) return undefined;
  const write = async () => {
    const dir = await summaryDir($);
    if (!dir) return undefined;
    const iso = new Date(at).toISOString();
    const stamp = iso.slice(0, 23).replace(/[-:]/g, '').replace('T', '-').replace('.', '');
    const path = `${dir}/${stamp}-${c.sessionId.replace(/[^\w-]/g, '_')}.md`;
    const head = `<!-- warm-compact ${VERSION}: session ${c.sessionId}, ${iso}, ${c.manual ? 'manual' : 'idle'} after ${c.idleMinutes} min, ${tokens(result.tokensBefore ?? c.tokensBefore)} -> ${tokens(result.tokensAfter)} tokens -->\n\n`;
    await $.fs.write(path, `${head}${summary}\n`);
    return path;
  };
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      write(),
      new Promise<undefined>(resolve => { timeout = $.clock.after(SAVE_MS, () => resolve(undefined)); }),
    ]);
  } catch {
    return undefined;
  } finally {
    timeout?.cancel();
  }
}

async function finish($: EngineInterface, c: Compacting, result: SessionCompactResult | undefined, failure?: string) {
  // A late answer of an attempt given up on must not close a newer one.
  if (compacting !== c) return;
  compacting = undefined;
  // The history was replaced or the attempt is over: nothing to wait out until the next request.
  if (!c.overtaken) {
    lastRequestAt = undefined;
    lastRequestTokens = undefined;
    await forgetRequest($);
  }
  const now = await $.clock.now();
  if (result && result.skip === undefined) {
    // The summary holds the open questions now.
    if (c.question !== undefined && openQuestion === c.question) openQuestion = undefined;
    const share = cachePercent(result.usage);
    const before = result.tokensBefore ?? c.tokensBefore;
    const file = await saveSummary($, c, now, result);
    const e: LogEntry = {
      ...entry(c, now, 'compacted', c.manual ? 'manual' : 'idle'),
      tokensBefore: before,
      tokensAfter: result.tokensAfter,
      cacheShare: share,
      summaryInput: result.usage ? result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens : undefined,
      summaryOutput: result.usage?.output_tokens,
      summaryFile: file,
    };
    const cache = share === undefined ? '' : say('cacheShare', { pct: share });
    const saved = file ? say('summarySaved', { file }) : '';
    await record($, e, say('compacted', { time: clockTime(now), idle: c.idleMinutes, before: tokens(before), after: tokens(result.tokensAfter), cache }) + saved);
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
  // A newer turn or timer that took over is not noted: it owns the timer now.
  const stale = (now: number) =>
    token !== generation ? undefined
    : working ? 'a turn is running'
    : compacting !== undefined && now - compacting.startedAt < STALE_MS ? 'a compaction is under way'
    : undefined;
  const start = await $.clock.now();
  if (token !== generation) return;
  const early = stale(start);
  if (early) {
    await quiet($, `timer: ${early}`, { sessionId, manual });
    return;
  }
  const base = { sessionId, idleMinutes: Math.round((start - since) / 60_000), manual };
  // A skip ends this idle period; the state is cleared only while no newer timer owns it.
  const skip = async (reason: string, line: string, tokensBefore?: number) => {
    if (token === generation) {
      await forget($);
      // Nor does a reload arm again from the request: the skip stands until the next turn.
      await forgetRequest($);
    }
    await record($, entry({ ...base, tokensBefore }, start, 'skipped', reason), line);
  };
  if ((await $.session.id()) !== sessionId) {
    await quiet($, 'timer: the session id changed', { sessionId, manual });
    return;
  }
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
  if (token !== generation) return;
  const late = stale(now);
  if (late) {
    await quiet($, `timer: ${late}`, { sessionId, tokensBefore: size, manual });
    return;
  }
  if (!manual && now - since > cfg.cutoffMs) {
    await skip('late', say('skipLate', { idle: Math.round((now - since) / 60_000) }));
    return;
  }
  const idleMinutes = Math.round((now - since) / 60_000);
  // Cards removed for this compaction: their questions go into the summary.
  const question = openQuestion;
  const note = instructions(cfg, clockTime(now), idleMinutes, manual, question);
  const attempt: Compacting = { token, sessionId, startedAt: now, idleMinutes, tokensBefore: size, manual, since, note, question };
  compacting = attempt;
  timer = undefined;
  dueAt = undefined;
  armedSince = undefined;
  // Cleared before compacting: a reload meanwhile must not start a second one.
  await forget($);
  await forgetRequest($);
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

/**
 * At the start of a turn: a timer still in the state well past its time did not
 * run to its end, as one that did clears it. A reload that dropped the timer and
 * did not arm it again leaves it so; kept even where this module never saw a
 * surface. The note is not awaited: the log never holds up the turn.
 */
async function lostTimer($: EngineInterface) {
  try {
    const { value } = await $.state.get(ARMED);
    if (!value || value.sessionId !== (await $.session.id())) return;
    const due = value.lastRequestAt + cfg.idleMs;
    if ((await $.clock.now()) - due > LOST_MS) void quiet($, `turn.start: the timer due at ${clockTime(due)} was still armed, it never fired or stopped early`, { sessionId: value.sessionId, always: true });
  } catch {}
}

/** Notes a turn of the main loop still running after the idle time: the timer waits on its end. */
function watchTurn($: EngineInterface, turnId: string) {
  turnWatch?.cancel();
  turnWatch = undefined;
  if (!drawn) return;
  turnWatch = $.clock.after(cfg.idleMs, () => {
    void (async () => {
      // A turn waiting on watched cards is the watch's: it ends the turn or notes why not.
      const owned = () => watch?.turnId === turnId;
      if (!working || currentTurn !== turnId || lastRequestAt === undefined || owned()) return;
      // Where no timer would be due (off, a small context) the long turn is no news.
      const sessionId = await $.session.id();
      if (await isOff($, sessionId)) return;
      const { context } = await $.session.usage();
      if ((context.tokens ?? 0) < cfg.minTokens) return;
      if (working && currentTurn === turnId && !owned()) await quiet($, `turn: a turn of the main loop has not ended after ${cfg.idleMs / 60_000} min`, { sessionId, tokensBefore: context.tokens });
    })().catch(() => {});
  });
}

/**
 * A card of the main loop's running turn: watched when the session would be
 * compacted, so the turn's cards are removed unanswered at the idle time.
 * `still` says whether the card is still up: one watched late, when a client
 * joins, may be answered while the watch reads.
 */
async function watchCard($: EngineInterface, id: string, questions: unknown, still: () => boolean = () => true): Promise<Watch | undefined> {
  const turnId = currentTurn;
  const since = lastRequestAt;
  if (!working || turnId === undefined || since === undefined) return undefined;
  await lookDrawn($);
  if (!drawn) return undefined;
  // Where no timer would be due (off, a small context) the card waits as it did.
  const sessionId = await $.session.id();
  if (await isOff($, sessionId)) return undefined;
  const { context } = await $.session.usage();
  if ((context.tokens ?? 0) < cfg.minTokens) return undefined;
  const now = await $.clock.now();
  // The reads took time: the turn may have been interrupted meanwhile, or the
  // card answered and the next request sent.
  if (!working || currentTurn !== turnId || lastRequestAt !== since || !still()) return undefined;
  // The request that put the card up started the cache's hour; a card that went
  // up late still stays its minimum. Removed less than the margin before the
  // cutoff, its compaction could start past it and be skipped.
  const same = watch !== undefined && watch.turnId === turnId && watch.since === since ? watch : undefined;
  const removeAt = Math.max(since + cfg.idleMs, now + CARD_MIN_MS, same?.removeAt ?? 0);
  if (removeAt - since > cfg.cutoffMs - CARD_MARGIN_MS) return undefined;
  let w = same;
  if (!w) {
    watch?.timer?.cancel();
    w = watch = { turnId, sessionId, since, shownAt: now, removeAt: 0, cards: new Map() };
  }
  w.cards.set(id, Array.isArray(questions) ? questions : []);
  if (removeAt !== w.removeAt) {
    const mine = w;
    mine.timer?.cancel();
    mine.removeAt = removeAt;
    mine.timer = $.clock.after(removeAt - now, () => {
      void removeCards($, mine).catch(err => quiet($, `card: ${errorText(err)}`, { sessionId }));
    });
    try {
      $.ui.log(say('cardNotice', { time: clockTime(removeAt) }));
    } catch {}
  }
  return w;
}

/**
 * The watch's timer: ends the turn that waits on the cards, with the gates `fire`
 * has, so the turn end compacts the session while the cache is warm.
 */
async function removeCards($: EngineInterface, w: Watch) {
  const token = generation;
  // Every card answered, or a turn that ended or was overtaken: nothing to remove.
  const up = () => watch === w && w.cards.size > 0 && working && currentTurn === w.turnId;
  if (!up()) return;
  const sessionId = await $.session.id();
  if (sessionId !== w.sessionId || (await isOff($, sessionId))) return;
  const { context, rateLimits } = await $.session.usage();
  const size = context.tokens;
  if ((size ?? 0) < cfg.minTokens) return;
  const busy = (await $.agent.list()).filter(a => BUSY_AGENTS.includes(a.status));
  // Read last: the reads above took time, and nothing below waits until the abort.
  const now = await $.clock.now();
  if (token !== generation || !up()) return;
  // Cards left up are noted: the turn, and the timer with it, waits on the answers.
  const keep = (reason: string) => quiet($, `card: ${reason}`, { sessionId, tokensBefore: size });
  if (now - w.since > cfg.cutoffMs - CARD_MARGIN_MS) return keep('late: the cache went cold while waiting');
  const limit = usedUp(rateLimits, now);
  if (limit) return keep(`the ${limit.kind} usage limit is used up`);
  if (busy.length) return keep(`${busy.length} agent(s) still running`);
  // Ending the turn stops every tool it runs, not the cards alone.
  if ([...running.values()].includes(w.turnId)) return keep('another tool of the turn is still running');
  const questions = [...w.cards.values()].flat();
  // Kept for the note: the turn end arms the timer, already due, and `fire` compacts.
  openQuestion = questionNote(cfg, questions);
  try {
    await $.turn.abort({ turnId: w.turnId });
  } catch (err) {
    openQuestion = undefined;
    return keep(`the turn was not ended: ${errorText(err)}`);
  }
  // A /clear meanwhile: the line would land in the next conversation.
  if ((await $.session.id().catch(() => undefined)) !== w.sessionId) return;
  $.ui.log(say('cardRemoved', { idle: Math.round((now - w.shownAt) / 60_000), question: questionLine(questions) }));
}

function schedule($: EngineInterface, sessionId: string, since: number, now: number) {
  const token = generation;
  dueAt = since + cfg.idleMs;
  armedSince = since;
  quietKept.clear();
  timer = $.clock.after(Math.max(0, dueAt - now), () => {
    void fire($, token, sessionId, since, false).catch(err => quiet($, `timer failed: ${errorText(err)}`, { sessionId }));
  });
}

/** At the end of a main-loop turn: arms the timer when the context is large enough. */
async function arm($: EngineInterface) {
  disarm();
  const token = generation;
  let since = lastRequestAt;
  const read = lastRequestTokens;
  // Headless runs (-p, an SDK script, a bot) draw nowhere: leave them alone. A
  // session that drew is armed while hidden too: the desktop app lists no surface
  // for a session moved off the screen, and that is where the user leaves it idle.
  await lookDrawn($);
  const sessionId = await $.session.id();
  if (await isOff($, sessionId)) return;
  const { context } = await $.session.usage();
  const now = await $.clock.now();
  if (token !== generation) return;
  const size = context.tokens ?? 0;
  if (size < cfg.minTokens) {
    await forget($);
    // The context reads small while the last request read a large one: the timer was due.
    if (read !== undefined && read >= cfg.minTokens && read - size >= GAP_TOKENS) await quiet($, `arm: the context reads ${size} tokens, the last request read ${read}`, { sessionId, tokensBefore: read, always: true });
    return;
  }
  // From here a timer was due: each exit is kept, a headless run's too, as it may be a hidden session taken for one.
  if (!drawn) {
    await quiet($, 'arm: no surface has drawn the session', { sessionId, tokensBefore: size, always: true });
    return;
  }
  if (since === undefined) {
    // A reload landed in the turn: its requests were seen by the module before.
    since = (await savedRequest($, sessionId).catch(() => undefined))?.at;
    if (token !== generation) return;
    if (since === undefined) {
      await quiet($, 'arm: no request of the main loop seen since the module loaded', { sessionId, tokensBefore: size });
      return;
    }
    lastRequestAt = since;
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

/**
 * A client joined a session not drawn before: hidden at its start, at each turn's
 * end and at each card, it was left alone as a headless run. What those left undone
 * is done now: the turn's open cards are watched, an idle main loop is armed. A
 * later join, the session drawn by then, only watches cards still left unwatched.
 */
async function catchUp($: EngineInterface) {
  if (working) {
    for (const [id, questions] of [...unwatched]) {
      // Answered while an earlier card was read: nothing to watch.
      if (!unwatched.has(id)) continue;
      const w = await watchCard($, id, questions, () => unwatched.has(id)).catch(() => undefined);
      if (!w) continue;
      // Nothing is awaited between the watch's last look (`still`) and its keeping the
      // card: one answered after that look is dropped by its own tool.call's finally.
      // Gone from `unwatched` otherwise, it was claimed by another join's catch-up.
      if (unwatched.delete(id)) running.delete(id);
    }
    return;
  }
  const since = lastRequestAt;
  // `timer` is the idle timer or the one /warm-compact now set: either owns the
  // session, as does a compaction under way or a turn.
  const idle = () => !working && lastRequestAt === since && timer === undefined && compacting === undefined;
  // A request seen without its turn's start: the module loaded mid-turn, and the turn may run still.
  if (since === undefined || currentTurn === undefined || !idle()) return;
  // Past the cutoff the cache is cold: the timer would only skip the session as late.
  const now = await $.clock.now();
  // Looked at again after the read: a turn may have started meanwhile. Nothing is
  // awaited from here until arm, whose own token covers what comes after.
  if (!idle() || now - since > cfg.cutoffMs) return;
  await arm($);
}

/** A card's call ended, answered or with its turn: with no card left, the watch has nothing to remove. */
function dropCard(id: string) {
  const w = watch;
  if (w?.cards.delete(id) && w.cards.size === 0) {
    w.timer?.cancel();
    watch = undefined;
  }
}

/** After a reload: arms again for what is left since this session's last request. */
async function rearm($: EngineInterface) {
  disarm();
  const token = generation;
  const { value } = await $.state.get(ARMED);
  const sessionId = await $.session.id();
  const now = await $.clock.now();
  if (token !== generation) return;
  if (!value || value.sessionId !== sessionId) {
    // A reload with no timer in the state: a turn that ended as the module was
    // swapped may not have kept it. Its last request still counts.
    if (!reloaded || working || (await isOff($, sessionId))) return;
    const saved = await savedRequest($, sessionId);
    if (token !== generation) return;
    // A turn under way: its end arms, in this module.
    if (saved && !saved.ended) {
      awaitingEnd = true;
      return;
    }
    const { context } = await $.session.usage();
    if (token !== generation || (context.tokens ?? 0) < cfg.minTokens) return;
    if (!saved) {
      await quiet($, 'session.start: a reload found no timer to pick up for a large context', { sessionId, tokensBefore: context.tokens });
      return;
    }
    // Past the cutoff the cache is cold already: nothing to arm for.
    if (now - saved.at > cfg.cutoffMs) return;
    lastRequestAt = saved.at;
    schedule($, sessionId, saved.at, now);
    await $.state.set(ARMED, { sessionId, lastRequestAt: saved.at }).catch(() => {});
    // Overtaken while writing: leave what a newer timer owns, as arm does.
    if (token !== generation) {
      if (armedSince === undefined) await forget($);
      else await $.state.set(ARMED, { sessionId, lastRequestAt: armedSince }).catch(() => {});
    }
    return;
  }
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
  // Cards left up past their time (noted why) wait as any running turn does.
  else if (watch && working && currentTurn === watch.turnId && now < watch.removeAt) armed = say('cardPending', { time: clockTime(watch.removeAt) });
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
      const outcome = say(e.outcome === 'compacted' ? 'outcomeCompacted' : e.outcome === 'skipped' ? 'outcomeSkipped' : e.outcome === 'noted' ? 'outcomeNoted' : 'outcomeFailed');
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
    // With no request yet there is nothing to count from: the next turn arms.
    if (!working && !compacting && lastRequestAt !== undefined) await arm($);
    return { text: say('turnedOn') };
  }
  if (args === 'now') {
    const now = await $.clock.now();
    if (working || (compacting && now - compacting.startedAt < STALE_MS)) return { text: say('busy') };
    disarm();
    quietKept.clear();
    const token = generation;
    const since = lastRequestAt ?? now;
    // Outside this hook: a compaction cannot run inside the command's own dispatch.
    timer = $.clock.after(1000, () => {
      void fire($, token, sessionId, since, true).catch(err => quiet($, `timer failed: ${errorText(err)}`, { sessionId, manual: true }));
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
    // A reload forgets the module's variables: whether the session draws is read
    // again, or taken from the mark a drawn session left before it was hidden.
    try {
      const { value } = await $.state.get(DRAWN);
      reloaded = !!value && value.sessionId === (await $.session.id());
      if (reloaded) drawn = true;
    } catch {}
    try {
      await lookDrawn($);
    } catch {}
    try {
      await $.command.register({ name: 'warm-compact', description: say('commandDescription'), argumentHint: 'status | now | off | on', immediate: true });
      await rearm($);
    } catch (err) {
      await quiet($, `session.start: ${errorText(err)}`);
    }
    return result;
  });

  // The roster is read at a start, a turn's end and a card alone: a desktop session
  // shown only in between, hidden at each of them, stayed a headless run with no
  // timer and no watch. A client joining marks it drawn and catches up.
  on('session.attach', async ($, e, next) => {
    const result = await next(e);
    try {
      const fresh = await markDrawn($);
      // Drawn already: another card may have read the roster first, and left the
      // cards that went up before it unwatched.
      if (fresh || (working && unwatched.size > 0)) await catchUp($);
    } catch (err) {
      await quiet($, `session.attach: ${errorText(err)}`);
    }
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
      if (now !== undefined) {
        lastRequestAt = now;
        // A headless run is never armed after a reload: nothing to keep. Not
        // awaited: the request to the model does not wait on the state.
        if (drawn) void keepRequest($, now, false);
      }
      // The main loop is busy again: a /compact still queued has nothing to do.
      if (compacting && !compacting.overtaken) compacting.overtaken = 'a turn ran first';
      // The conversation moved on, the questions with it: the user may have answered them.
      openQuestion = undefined;
    }
    const result = yield* next(e);
    const u = result?.usage;
    if (e.agentId === undefined && u) lastRequestTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    return result;
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const unfinished = working;
      // A timer or compaction of this module is alive, only late (a host that slept): not lost.
      const live = timer !== undefined || compacting !== undefined;
      disarm();
      working = true;
      currentTurn = e.turnId;
      try {
        watchTurn($, e.turnId);
      } catch {}
      if (unfinished) void quiet($, 'turn.start: the previous turn of the main loop did not end');
      if (awaitingEnd) void quiet($, 'turn.start: the turn under way at the reload did not end in this module');
      awaitingEnd = false;
      if (!live) await lostTimer($);
      await forget($);
      if (drawn) await keepRequest($, undefined, false);
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const armed = generation;
    let result: Awaited<ReturnType<typeof next>>;
    try {
      result = await next(e);
    } catch (err) {
      if (e.agentId === undefined) void quiet($, `turn.complete failed: ${errorText(err)}`);
      throw err;
    }
    if (e.agentId !== undefined) return result;
    if (currentTurn === e.turnId) {
      turnWatch?.cancel();
      turnWatch = undefined;
    }
    currentTurn ??= e.turnId;
    // A turn that started meanwhile owns the state now.
    if (armed !== generation) {
      // Unless no turn started: then nothing will arm the timer, and a turn seems to run on.
      if (currentTurn === e.turnId) void quiet($, 'turn.complete: the state changed while the turn ended, the timer was not armed');
      return result;
    }
    working = false;
    awaitingEnd = false;
    if (drawn) await keepRequest($, lastRequestAt, true);
    // A turn that started while the end was kept owns the state now.
    if (armed !== generation) return result;
    // Never let arming the timer break the turn.
    await arm($).catch(err => void quiet($, `arm or saving the timer failed: ${errorText(err)}`));
    return result;
  });

  // A card keeps the turn open until it is answered, so no turn end arms the timer.
  // Removed unanswered at the idle time, it ends the turn: the turn end compacts.
  // The model's own calls alone: another plugin's question is not the turn's.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || next.origin.plugin !== 'engine') return next(e);
    const id = e.tool_use_id;
    const card = e.tool === 'AskUserQuestion';
    const w = card ? await watchCard($, id, e.questions).catch(() => undefined) : undefined;
    if (!w) running.set(id, currentTurn);
    if (card && !w) unwatched.set(id, e.questions);
    try {
      return await next(e);
    } finally {
      running.delete(id);
      unwatched.delete(id);
      // Watched when it went up or when a client joined: the watch lets it go.
      dropCard(id);
    }
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
      lastRequestTokens = undefined;
      await forget($);
      await forgetRequest($);
    }
    return result;
  });

  on('session.end', async ($, e, next) => {
    // Also a /clear: the conversation ends and the process goes on under a new id.
    disarm();
    lastRequestAt = undefined;
    working = false;
    compacting = undefined;
    turnWatch?.cancel();
    turnWatch = undefined;
    currentTurn = undefined;
    watch?.timer?.cancel();
    watch = undefined;
    running.clear();
    unwatched.clear();
    openQuestion = undefined;
    drawn = false;
    reloaded = false;
    awaitingEnd = false;
    lastRequestTokens = undefined;
    await forgetRequest($);
    quietKept.clear();
    await forget($);
    await $.state.set(DRAWN, null).catch(() => {});
    return next(e);
  });
};
