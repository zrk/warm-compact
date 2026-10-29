import type { AgentInfo, On, SessionRateLimit, ToolCallResult } from 'claude-code';
import { expect, mock, test, type Engine, type MockClock, type Plugin } from 'claude-code/testing';
import { isHeadlessRefusal } from '../hooks/register.ts';
import { clockTime, questionLine, questionNote, settings } from '../hooks/text.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-23T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DESKTOP = { cwd: '/work', surface: null, isInteractive: false } as const;
const TERMINAL = { cwd: '/work', surface: 'terminal', isInteractive: true } as const;
const RU = { options: { language: 'ru' } };

type World = {
  tokens: number;
  agents: AgentInfo[];
  surfaces: string[];
  rateLimits: SessionRateLimit[];
  // Set while a /compact command waits for the test to run its turn.
  release?: () => void;
  pending?: string;
  env?: Record<string, string>;
  failWrite?: boolean;
  hangWrite?: boolean;
  messages?: unknown;
  // $.state as a reload finds it: what the session wrote before the module was loaded.
  state?: Record<string, unknown>;
  failAbort?: boolean;
  // Run as the engine ends the turn: a /clear at that moment, say.
  onAbort?: () => void;
  sessionId?: string;
  // The next read of each is held up this long: the computer slept, or something
  // happened meanwhile; what is read after it comes that much later.
  lag?: { 'session.id'?: number; 'agent.list'?: number; 'session.usage'?: number; 'state.set'?: number };
};

function fixture(on: On, initial: Partial<World> = {}) {
  const clock = mock.clock(on, { now: NOW });
  const store = new Map<string, unknown>();
  on('store.get', ($, e) => ({ value: store.get(e.key) }));
  on('store.set', ($, e) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined }; });
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined }; });
  // The kit keeps $.state; the test seeds what a reload would find there, until
  // the mod writes that key itself, and sees every write the mod makes.
  const seeded = new Map<string, unknown>(Object.entries(initial.state ?? {}));
  const state = new Map<string, unknown>();
  on('state.get', ($, e, next) => (seeded.has(e.key) ? { value: { value: seeded.get(e.key), version: 1 } } : next(e)) as never);
  on('state.set', ($, e, next) => {
    const write = () => {
      seeded.delete(e.key);
      state.set(e.key, JSON.parse(JSON.stringify(e.value)));
      return next(e);
    };
    // A write held up by `lag` lands that much later; any other at once.
    return (world.lag?.['state.set'] ? held('state.set').then(write) : write()) as never;
  });
  const world: World = { tokens: 300_000, agents: [], surfaces: ['desktop'], rateLimits: [], ...initial };
  const aborts: string[] = [];
  // Every tool call stays open until the test answers it or its turn is aborted.
  const open = new Map<string, { input: string; resolve: (result: ToolCallResult) => void }>();
  on('tool.call', ($, e) => new Promise<ToolCallResult>(resolve => { open.set(e.tool_use_id, { input: JSON.stringify(e), resolve }); }));
  // The engine stops every running tool of the turn: each open call resolves as an error.
  on('turn.abort', ($, e) => {
    if (world.failAbort) return { deny: `${e.turnId} is not the running turn` };
    aborts.push(e.turnId);
    world.onAbort?.();
    for (const [id, call] of open) {
      open.delete(id);
      call.resolve(ABORTED);
    }
    return { value: undefined };
  });
  const held = async (op: 'session.id' | 'agent.list' | 'session.usage' | 'state.set') => {
    const ms = world.lag?.[op];
    if (!ms) return;
    world.lag = { ...world.lag, [op]: undefined };
    await clock.sleep(ms);
  };
  const logs: string[] = [];
  const commands: { command: string; args?: string }[] = [];
  const direct: (string | undefined)[] = [];
  const files = new Map<string, string>();
  const env: Record<string, string> = { HOME: '/home/u', ...initial.env };
  on('env.get', ($, e) => ({ value: env[e.name] }));
  on('fs.write', async ($, e) => {
    if (initial.failWrite) throw new Error('disk full');
    if (initial.hangWrite) await new Promise(() => {});
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on('session.id', async () => {
    await held('session.id');
    return { value: world.sessionId ?? 'test-session' };
  });
  on('session.usage', async () => {
    await held('session.usage');
    return { value: { startedAt: NOW, context: { tokens: world.tokens, window: 1_000_000 }, rateLimits: world.rateLimits } };
  });
  on('agent.list', async () => {
    await held('agent.list');
    return { value: world.agents };
  });
  on('session.surfaces', () => ({ value: world.surfaces as never }));
  on('command.register', () => ({ value: { command: 'warm-compact' } }));
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined }; });
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('session.attach', ($, e) => ({ clientId: e.clientId }));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  // The instructions of every compaction that ran, as they reached it.
  const compactions: (string | undefined)[] = [];
  on('session.compact', ($, e) => {
    compactions.push(e.instructions);
    // A compaction outside a /compact turn is the mod's direct call.
    if (world.pending === undefined) {
      direct.push(e.instructions);
    }
    const before = world.tokens;
    world.tokens = 20_000;
    return { messages: (world.messages ?? SUMMARY) as never, tokensBefore: before, tokensAfter: 15_000, usage: { input_tokens: 10, cache_read_input_tokens: 290_000, cache_creation_input_tokens: 9_990, output_tokens: 4_000 } };
  });
  // The /compact command waits until the test runs its turn (compactTurn).
  on('command.run', async ($, e) => {
    commands.push({ command: e.command, args: e.args });
    if (e.command === 'compact') {
      world.pending = e.args;
      await new Promise<void>(resolve => { world.release = resolve; });
      world.pending = undefined;
    }
    return { text: '' };
  });
  return { clock, world, logs, commands, direct, store, files, state, aborts, open, compactions };
}

const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }, { role: 'assistant', text: 'kept', toolUses: [] }] as never;

const QUESTION = {
  question: 'Which date library should we use?',
  header: 'Library',
  multiSelect: false,
  options: [{ label: 'date-fns', description: 'Tree-shakes' }, { label: 'dayjs', description: 'Smallest' }],
};
const RUNNER = {
  question: 'Which test runner?',
  header: 'Runner',
  multiSelect: true,
  options: [{ label: 'vitest', description: 'Fast' }, { label: 'jest', description: 'Known' }],
};
const SHIP = {
  question: 'Ship it today?',
  header: 'Ship',
  multiSelect: false,
  options: [{ label: 'Yes', description: 'Now' }, { label: 'No', description: 'Wait' }],
};
// The questions as the session line quotes them, and as the summarizer gets them, whole.
const QUOTED = '"Which date library should we use?" (date-fns / dayjs)';
const SHIP_QUOTED = '"Ship it today?" (Yes / No)';
const FULL = 'Library: "Which date library should we use?" (one answer), options: "date-fns" — Tree-shakes; "dayjs" — Smallest.';
const RUNNER_FULL = 'Runner: "Which test runner?" (several answers allowed), options: "vitest" — Fast; "jest" — Known.';
const SHIP_FULL = 'Ship: "Ship it today?" (one answer), options: "Yes" — Now; "No" — Wait.';
const ANSWERED: ToolCallResult = { result: { answers: { [QUESTION.question]: 'dayjs' } }, text: 'User answered: dayjs' };
// What an open call resolved to when the engine aborted its turn (2.1.308).
const ABORTED: ToolCallResult = { result: 'Error: Tool permission request aborted', text: 'Tool permission request aborted', isError: true };

// The person answers the first open call whose input holds `match`.
function answer(f: { open: Map<string, { input: string; resolve: (result: ToolCallResult) => void }> }, result: ToolCallResult, match = '') {
  const [id, call] = [...f.open].find(([, c]) => c.input.includes(match)) ?? [];
  if (id === undefined || call === undefined) throw new Error(`no open call holds ${match}`);
  f.open.delete(id);
  call.resolve(result);
}

// The line shown when a card is watched, with the time it will be removed.
const watching = (at: number) => `warm-compact: a question card waits for an answer; if it is not answered by ${clockTime(at)}, it is removed and the session compacted while the cache is warm.`;

// The /compact command as an SDK session runs it: a turn of its own around the compaction.
type Fixture = ReturnType<typeof fixture>;

async function compactTurn($: Engine, f: Fixture) {
  expect(f.world.pending).toBeDefined();
  await $.turn.start({ turnId: 'compact-turn', text: '' });
  await $.session.compact({ trigger: 'manual', instructions: f.world.pending, messages: SUMMARY });
  await $.turn.complete({ turnId: 'compact-turn', answer: '', durationMs: 1, isAborted: false, reason: 'answer' });
  f.world.release?.();
  await f.clock.advance(0);
}

// The person's /warm-compact, as the engine dispatches it.
function command($: Engine, args: string) {
  return $.command.run({ command: 'warm-compact', args, origin: { kind: 'composer' }, presentation: { fullscreen: false, columns: 80 } } as never);
}

let turns = 0;
async function turn($: Engine, clock: MockClock, opts: { stepAt?: number; endAt?: number } = {}) {
  const turnId = `turn-${++turns}`;
  await $.turn.start({ turnId, text: 'hello' });
  if (opts.stepAt) await clock.advance(opts.stepAt);
  const steps = $.turn.step({ turnId, index: 0, model: 'test', messageCount: 1 });
  for await (const _ of steps) { /* drain */ }
  if (opts.endAt) await clock.advance(opts.endAt);
  await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
}

// A turn of the main loop after its first request: the answer's cards and tools come next.
async function requestInTurn($: Engine) {
  const turnId = `turn-${++turns}`;
  await $.turn.start({ turnId, text: 'hello' });
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
  return turnId;
}

// The model's card, its call left open; with `agentId`, a subagent asks instead.
function ask($: Engine, questions: readonly (typeof QUESTION)[] = [QUESTION], agentId?: string) {
  return $.tool.call({ tool: 'AskUserQuestion', questions: [...questions], ...(agentId === undefined ? {} : { agentId }) });
}

async function askInTurn($: Engine, f: Fixture, agentId?: string) {
  const turnId = await requestInTurn($);
  const call = ask($, [QUESTION], agentId);
  await f.clock.settle();
  return { turnId, call };
}

// A card the mod leaves alone: no line, no abort, the call waits beneath, and the answer comes back as given.
async function passedThrough(f: Fixture, call: Promise<unknown>, expected: unknown = ANSWERED) {
  expect(f.logs.filter(l => l.includes('question card'))).toEqual([]);
  expect(f.aborts).toEqual([]);
  expect(f.open.size).toBe(1);
  answer(f, ANSWERED);
  expect(await call).toEqual(expected);
}

function ended($: Engine, turnId: string, reason: 'answer' | 'aborted') {
  return $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: reason === 'aborted', reason });
}

function stored(f: Fixture) {
  return (f.store.get('log') ?? []) as { outcome: string; reason: string; tokensBefore?: number; tokensAfter?: number; cacheShare?: number; summaryFile?: string }[];
}

test('desktop: compacts through /compact 52 minutes after the last request, not earlier', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock, { endAt: 2 * MIN });
  // The count runs from the request, so two minutes of the answer are already gone.
  await f.clock.advance(50 * MIN - 1);
  expect(f.commands).toEqual([]);
  await f.clock.advance(1);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(f.commands[0]?.command).toBe('compact');
  expect(f.commands[0]?.args).toContain('ran automatically');
  expect(f.direct).toEqual([]);
  const log = stored(f);
  expect(log.length).toBe(1);
  expect(log[0]?.outcome).toBe('compacted');
  expect(log[0]?.tokensBefore).toBe(300_000);
  expect(log[0]?.tokensAfter).toBe(15_000);
  expect(log[0]?.cacheShare).toBe(96);
  expect(f.logs.at(-1)).toContain('compacted at');
  // The compaction's own turn does not arm the timer again.
  await f.clock.advance(120 * MIN);
  expect(f.commands.length).toBe(1);
});

test('terminal: the direct call compacts, no command runs', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'] });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.direct.length).toBe(1);
  expect(f.commands).toEqual([]);
  expect((stored(f))[0]?.outcome).toBe('compacted');
});

test('the engine refusal of the direct call is recognised, other errors are not', () => {
  // Word for word from the engine (2.1.308): the fallback to /compact keys on it.
  const refusal = new Error('not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on');
  expect(isHeadlessRefusal(refusal)).toBe(true);
  expect(isHeadlessRefusal(new Error('a turn is running'))).toBe(false);
});

test('a headless run is left alone', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(120 * MIN);
  expect(f.commands).toEqual([]);
  expect(stored(f)).toEqual([]);
});

test('a context under the floor is left alone', async ($, on) => {
  const f = fixture(on, { tokens: 150_000 });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(120 * MIN);
  expect(f.commands).toEqual([]);
  expect(stored(f)).toEqual([]);
});

test('a new turn cancels the timer and starts the count again', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(40 * MIN);
  await turn($, f.clock);
  await f.clock.advance(40 * MIN);
  expect(f.commands).toEqual([]);
  await f.clock.advance(12 * MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

test('a timer later than the cutoff skips: the cache is cold', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  // The last request at the start, the turn ended (an interrupted tool) 58 minutes later.
  await turn($, f.clock, { endAt: 58 * MIN });
  await f.clock.advance(MIN);
  expect(f.commands).toEqual([]);
  // The turn ran past the idle time: the watch on it noted that first.
  const log = stored(f);
  expect(log.map(e => [e.outcome, e.reason])).toEqual([['noted', 'turn: a turn of the main loop has not ended after 52 min'], ['skipped', 'late']]);
});

test('running agents skip the idle period', async ($, on) => {
  const f = fixture(on, { agents: [{ id: 'a1', description: 'scan', type: 'Explore', status: 'running' } as AgentInfo] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.commands).toEqual([]);
  expect((stored(f))[0]?.reason).toBe('agents');
});

test('a used-up limit that has not reset skips', async ($, on) => {
  const f = fixture(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + 3 * HOUR) }] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.commands).toEqual([]);
  expect(f.direct).toEqual([]);
  const log = stored(f);
  expect(log.length).toBe(1);
  expect(log[0]?.outcome).toBe('skipped');
  expect(log[0]?.reason).toBe('limited');
  expect(f.logs.at(-1)).toContain('the five_hour usage limit is used up');
});

test('a limit that reset before the timer fired, or one short of 100, does not stop it', async ($, on) => {
  const f = fixture(on, { rateLimits: [
    // The last reading still says 100, but the window reset 42 minutes before the timer.
    { kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + 10 * MIN) },
    { kind: 'seven_day', percentUsed: 99.9, resetsAt: iso(NOW + 72 * HOUR) },
  ] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f)[0]?.outcome).toBe('compacted');
});

test('a used-up window with no reset time skips too', async ($, on) => {
  const f = fixture(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 100 }] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.commands).toEqual([]);
  expect(stored(f)[0]?.reason).toBe('limited');
});

test('now skips while the limit is used up', async ($, on) => {
  const f = fixture(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + 3 * HOUR) }] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await command($, 'now');
  await f.clock.advance(1000);
  expect(f.commands.filter(c => c.command === 'compact')).toEqual([]);
  expect(stored(f)[0]?.reason).toBe('limited');
});

test('off stops this session, on arms it again', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  const off = await command($, 'off');
  expect(off.text).toContain('off');
  await f.clock.advance(60 * MIN);
  expect(f.commands.filter(c => c.command === 'compact')).toEqual([]);
  await turn($, f.clock);
  await f.clock.advance(60 * MIN);
  expect(f.commands.filter(c => c.command === 'compact')).toEqual([]);
  await command($, 'on');
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.commands.filter(c => c.command === 'compact').length).toBe(1);
  await compactTurn($, f);
});

test('someone else compacting cancels the timer', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await $.session.compact({ trigger: 'manual', messages: SUMMARY });
  await f.clock.advance(60 * MIN);
  expect(f.commands).toEqual([]);
  expect(stored(f)).toEqual([]);
});

test('someone else compacting in the middle of a turn: the turn end arms again', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await $.turn.start({ turnId: 'mid', text: 'hello' });
  for await (const _ of $.turn.step({ turnId: 'mid', index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
  // Between two requests of one turn: the turn end reads the state when it begins, so it still arms.
  await $.session.compact({ trigger: 'auto', messages: SUMMARY });
  f.world.tokens = 300_000;
  for await (const _ of $.turn.step({ turnId: 'mid', index: 1, model: 'test', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 'mid', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await f.clock.advance(52 * MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

test('/clear cancels the timer', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { sessionId: 'test-session' } } as never);
  await f.clock.advance(60 * MIN);
  expect(f.commands).toEqual([]);
});

test('a turn overtaken by the next one is noted, and the next end arms', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await $.turn.start({ turnId: 'a', text: 'hello' });
  for await (const _ of $.turn.step({ turnId: 'a', index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
  // A second turn of the main loop starts before the first one ends.
  await $.turn.start({ turnId: 'b', text: '' });
  await $.turn.complete({ turnId: 'a', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await f.clock.advance(0);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'turn.start: the previous turn of the main loop did not end']]);
  // Nothing is shown in the session for a quiet exit.
  expect(f.logs).toEqual([]);
  await $.turn.complete({ turnId: 'b', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await f.clock.advance(52 * MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

test('a session moved off the screen is still compacted', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  // The desktop app lists no surface for a hidden session.
  f.world.surfaces = [];
  await turn($, f.clock);
  await f.clock.advance(52 * MIN - 1);
  expect(f.commands).toEqual([]);
  await f.clock.advance(1);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a turn that never ends is noted once after the idle time', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await $.turn.start({ turnId: 'stuck', text: '' });
  for await (const _ of $.turn.step({ turnId: 'stuck', index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
  await f.clock.advance(52 * MIN - 1);
  expect(stored(f)).toEqual([]);
  await f.clock.advance(3 * HOUR);
  expect(f.commands).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'turn: a turn of the main loop has not ended after 52 min']]);
});

test('a headless run after /clear of a drawn session is not noted', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { sessionId: 'test-session' } } as never);
  f.world.surfaces = [];
  await turn($, f.clock);
  await f.clock.advance(120 * MIN);
  expect(stored(f)).toEqual([]);
});

test('a reload arms again for the time left', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(30 * MIN);
  // session.start runs again on a reload: the timer from the state, not from now.
  await $.session.start(DESKTOP);
  await f.clock.advance(22 * MIN - 1);
  expect(f.commands.length).toBe(0);
  await f.clock.advance(1);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

test('a drawn session leaves its mark in the state, and session end clears it', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  expect(f.state.get('drawn')).toEqual({ sessionId: 'test-session' });
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { sessionId: 'test-session' } } as never);
  expect(f.state.get('drawn')).toBeNull();
});

test('a session first drawn at the end of a turn leaves its mark too', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  expect(f.state.has('drawn')).toBe(false);
  f.world.surfaces = ['desktop'];
  await turn($, f.clock);
  expect(f.state.get('drawn')).toEqual({ sessionId: 'test-session' });
});

// Each test loads a fresh module: a mark already in the state, and no surface,
// is a reload of a session hidden at the time.
test('a reload while hidden keeps the session armed', async ($, on) => {
  const f = fixture(on, { surfaces: [], state: { drawn: { sessionId: 'test-session' } } });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN - 1);
  expect(f.commands).toEqual([]);
  await f.clock.advance(1);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a mark of another session does not make a headless run drawn', async ($, on) => {
  const f = fixture(on, { surfaces: [], state: { drawn: { sessionId: 'other-session' } } });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(120 * MIN);
  expect(f.commands).toEqual([]);
  expect(stored(f)).toEqual([]);
});

// The desktop app lists a client only while it shows the session: one shown only
// between a start, a turn's end and a card is seen drawn by the client joining.
const JOIN = { surface: 'desktop', clientId: 'desktop:default' } as const;

test('a client joining a session hidden at its turn end arms the timer for the time left', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(10 * MIN);
  await $.session.attach(JOIN);
  expect(f.state.get('drawn')).toEqual({ sessionId: 'test-session' });
  await f.clock.advance(42 * MIN - 1);
  expect(f.commands).toEqual([]);
  await f.clock.advance(1);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a client joining past the cutoff leaves the cold session alone', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(58 * MIN);
  await $.session.attach(JOIN);
  await f.clock.advance(2 * HOUR);
  expect(f.commands).toEqual([]);
  expect(stored(f)).toEqual([]);
  expect(f.logs).toEqual([]);
});

test('a card that went up while the session was hidden is watched when a client joins', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  expect(f.logs).toEqual([]);
  await f.clock.advance(20 * MIN);
  await $.session.attach(JOIN);
  // Due 52 minutes after the request that put the card up, as had the session been drawn then.
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  await f.clock.advance(32 * MIN - 1);
  expect(f.aborts).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(f.compactions[0]).toContain(`the user's next message may answer it: ${FULL}`);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a card answered while the joining client is read is not watched: no line, nothing removed', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  await f.clock.advance(20 * MIN);
  // The watch reads the usage late: the person answers the card meanwhile.
  f.world.lag = { 'session.usage': MIN };
  const joined = $.session.attach(JOIN);
  await f.clock.settle();
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
  await f.clock.advance(MIN);
  await joined;
  // No line names a removal time for a card already answered.
  expect(f.logs).toEqual([]);
  // The model works on past the card's time: nothing is left to remove.
  for await (const _ of $.turn.step({ turnId, index: 1, model: 'test', messageCount: 3 })) { /* drain */ }
  await f.clock.advance(40 * MIN);
  expect(f.aborts).toEqual([]);
});

test('a card answered while the joining client is read leaves the watch to the next card', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  await f.clock.advance(20 * MIN);
  // The watch reads the usage late: meanwhile the person answers, and the model asks again at once.
  f.world.lag = { 'session.usage': MIN };
  const joined = $.session.attach(JOIN);
  await f.clock.settle();
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
  for await (const _ of $.turn.step({ turnId, index: 1, model: 'test', messageCount: 3 })) { /* drain */ }
  const next = ask($, [SHIP]);
  await f.clock.settle();
  await f.clock.advance(MIN);
  await joined;
  // The next card is removed 52 minutes after the request that put it up.
  await f.clock.advance(51 * MIN - 1);
  expect(f.aborts).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([turnId]);
  expect(await next).toEqual(ABORTED);
  expect(f.logs.filter(l => l.includes('waits for an answer'))).toEqual([watching(NOW + 72 * MIN)]);
});

test('a card left unwatched is watched when its client joins, though another card saw the session drawn first', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  const turnId = await requestInTurn($);
  const first = ask($, [QUESTION]);
  await f.clock.settle();
  // The roster lists the client before its join is raised: the second card of the answer reads it first.
  f.world.surfaces = ['desktop'];
  const second = ask($, [SHIP]);
  await f.clock.settle();
  await $.session.attach(JOIN);
  await f.clock.advance(52 * MIN);
  // One removal ends the turn, and both cards with it.
  expect(f.aborts).toEqual([turnId]);
  expect(await first).toEqual(ABORTED);
  expect(await second).toEqual(ABORTED);
});

test('a client joining after the idle time, before the cutoff, compacts at once', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(55 * MIN);
  await $.session.attach(JOIN);
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a client joining before /warm-compact now fires keeps the compaction it promised', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(5 * MIN);
  await command($, 'now');
  await $.session.attach(JOIN);
  await f.clock.advance(1000);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'manual']]);
});

test('a client joining as /warm-compact now begins to compact does not cancel it', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(5 * MIN);
  await command($, 'now');
  // The compaction has begun and clears the state; the client joins while that write is under way.
  f.world.lag = { 'state.set': MIN };
  await f.clock.advance(1000);
  await $.session.attach(JOIN);
  await f.clock.advance(MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'manual']]);
});

// A plugin around the clock: with `hold-read` in the store, the next read of the time
// waits a minute of the test's clock, as a hook that awaits the clock while the session moves on.
const HOLD_READ: Plugin = {
  name: 'hold-read',
  register(on) {
    on('clock.now', async ($, e, next) => {
      if ((await $.store.get('hold-read')) === true) {
        await $.store.delete('hold-read');
        await $.clock.sleep(60_000);
      }
      return next(e);
    });
  },
};

test('a turn that starts while the joining client is read is armed by its own end alone', { plugins: [HOLD_READ] }, async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(10 * MIN);
  // The catch-up finds the main loop idle and reads the clock; the turn starts meanwhile.
  f.store.set('hold-read', true);
  const joined = $.session.attach(JOIN);
  await f.clock.settle();
  expect(f.store.has('hold-read')).toBe(false);
  await $.turn.start({ turnId: 'joined', text: 'hello' });
  await f.clock.advance(MIN);
  await joined;
  // Nothing is armed while the turn runs: no timer kept in the state, none fires.
  expect(f.state.get('armed')).toBeNull();
  await f.clock.advance(42 * MIN);
  expect(stored(f)).toEqual([]);
  // Its end arms as any turn's.
  for await (const _ of $.turn.step({ turnId: 'joined', index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 'joined', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await f.clock.advance(52 * MIN);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

// A reload in the middle of a turn: the module never saw the turn start, and takes the main loop for idle.
test('a client joining a session already drawn arms nothing: after a reload mid-turn, the turn end arms', async ($, on) => {
  const f = fixture(on, { surfaces: [], state: { drawn: { sessionId: 'test-session' } } });
  await $.session.start(DESKTOP);
  for await (const _ of $.turn.step({ turnId: 'running', index: 1, model: 'test', messageCount: 3 })) { /* drain */ }
  await $.session.attach(JOIN);
  await f.clock.advance(52 * MIN);
  expect(f.commands).toEqual([]);
  // Its end arms the timer, already due.
  await $.turn.complete({ turnId: 'running', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('status and now answer in Russian when configured', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  const status = await command($, 'status');
  expect(status.text).toContain('Взведён: сожмёт в');
  const now = await command($, 'now');
  expect(now.text).toContain('Сжатие');
  await f.clock.advance(1000);
  expect(f.commands.filter(c => c.command === 'compact').length).toBe(1);
  await compactTurn($, f);
  expect(f.commands.find(c => c.command === 'compact')?.args).toContain('вручную');
  expect(f.logs.at(-1)).toContain('сжато в');
});

test('the desktop text command is answered locally', async ($, on) => {
  fixture(on);
  on('prompt.submit', ($, e) => ({ text: e.text }));
  await $.session.start(DESKTOP);
  const reply = await $.prompt.submit({ text: '/warm-compact status', origin: { kind: 'composer' } } as never);
  expect((reply as { drop?: string }).drop).toContain('warm-compact 0.2.5');
});

test('a turn of the person before the queued /compact skips it and arms again', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.world.pending).toBeDefined();
  // The person's message ran first; the queued command comes after it.
  await turn($, f.clock);
  await compactTurn($, f);
  const log = stored(f);
  expect(log.length).toBe(1);
  expect(log[0]?.outcome).toBe('skipped');
  expect(log[0]?.reason).toBe('vetoed: a turn ran first');
  expect(f.world.tokens).toBe(300_000);
  // The person's turn counts: a new idle period compacts in its turn.
  await f.clock.advance(52 * MIN);
  expect(f.commands.length).toBe(2);
});

test('someone else compacting first skips the queued /compact', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  const queued = f.world.pending;
  f.world.pending = undefined;
  await $.session.compact({ trigger: 'manual', instructions: 'by hand', messages: SUMMARY });
  f.world.pending = queued;
  await compactTurn($, f);
  const log = stored(f);
  expect(log.length).toBe(1);
  expect(log[0]?.reason).toBe('vetoed: compacted by someone else first');
});

test('/clear while compacting leaves nothing stuck', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { sessionId: 'test-session' } } as never);
  const status = await command($, 'status');
  expect(status.text).not.toContain('Compacting now');
  f.world.release?.();
  await f.clock.advance(0);
  expect(stored(f)).toEqual([]);
});

test('settings stay under the one-hour cache', () => {
  expect(settings({}).idleMs).toBe(52 * MIN);
  expect(settings({}).cutoffMs).toBe(57 * MIN);
  expect(settings({ idleMinutes: 59.5, cutoffMinutes: 57 }).idleMs).toBe(52 * MIN);
  expect(settings({ idleMinutes: 59.5, cutoffMinutes: 57 }).cutoffMs).toBe(57 * MIN);
  expect(settings({ cutoffMinutes: 75 }).cutoffMs).toBe(57 * MIN);
  expect(settings({ idleMinutes: 58 }).cutoffMs).toBe(59 * MIN);
  expect(settings({ idleMinutes: 30, cutoffMinutes: 40 }).cutoffMs).toBe(40 * MIN);
});

test('off drops a /compact still waiting in the queue', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  await command($, 'off');
  await compactTurn($, f);
  expect(stored(f)[0]?.reason).toBe('vetoed: turned off');
  expect(f.world.tokens).toBe(300_000);
});

test('a /compact that waited past the cutoff skips: the cache went cold', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  await f.clock.advance(6 * MIN);
  await compactTurn($, f);
  expect(stored(f)[0]?.reason).toBe('vetoed: late: the cache went cold while waiting');
  expect(f.world.tokens).toBe(300_000);
});

test('the summary is saved to a file the log names', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'] });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  const path = '/home/u/.claude/plugins/data/warm-compact/summaries/20261023-105200000-test-session.md';
  expect([...f.files.keys()]).toEqual([path]);
  const text = f.files.get(path) ?? '';
  expect(text).toContain('session test-session');
  expect(text).toContain('300k -> 15k tokens');
  expect(text.endsWith('summary\n')).toBe(true);
  expect(text).not.toContain('kept');
  expect((stored(f))[0]?.summaryFile).toBe(path);
  expect(f.logs.at(-1)).toContain(`Summary saved: ${path}`);
});

test('CLAUDE_CONFIG_DIR moves the summaries', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], env: { CLAUDE_CONFIG_DIR: '/cfg/' } });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect([...f.files.keys()][0]?.startsWith('/cfg/plugins/data/warm-compact/summaries/')).toBe(true);
});

test('a failed write keeps the compaction and its log entry', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], failWrite: true });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  const log = stored(f);
  expect(log[0]?.outcome).toBe('compacted');
  expect(log[0]?.summaryFile).toBeUndefined();
  expect(f.logs.at(-1)).not.toContain('Summary saved');
});

test('a write that never settles gives up after five seconds', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], hangWrite: true });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(stored(f)).toEqual([]);
  await f.clock.advance(5_000);
  const log = stored(f);
  expect(log[0]?.outcome).toBe('compacted');
  expect(log[0]?.summaryFile).toBeUndefined();
});

test('no file when the first message is not a summary', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], messages: [{ role: 'user', text: '  ', toolUses: [] }, { role: 'assistant', text: 'kept', toolUses: [] }] });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.files.size).toBe(0);
  expect((stored(f))[0]?.outcome).toBe('compacted');
});

test('two compactions in one minute get two files', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'] });
  await $.session.start(TERMINAL);
  await command($, 'now');
  await f.clock.advance(1000);
  await f.clock.advance(1000);
  await command($, 'now');
  await f.clock.advance(1000);
  expect(f.files.size).toBe(2);
});

test('desktop: the /compact path saves the summary too', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  await compactTurn($, f);
  expect(f.files.size).toBe(1);
  expect((stored(f))[0]?.summaryFile).toBe([...f.files.keys()][0]);
});

test('no home and no config dir: no file, the compaction stands', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], env: { HOME: '' } });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  expect(f.files.size).toBe(0);
  expect((stored(f))[0]?.outcome).toBe('compacted');
});

test('Windows: USERPROFILE with a trailing backslash', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'], env: { HOME: '', USERPROFILE: 'C:\\Users\\u\\' } });
  await $.session.start(TERMINAL);
  await turn($, f.clock);
  await f.clock.advance(52 * MIN);
  // The mock file system on a POSIX host resolves a Windows path against the working directory.
  expect([...f.files.keys()][0]?.includes('C:\\Users\\u/.claude/plugins/data/warm-compact/summaries/')).toBe(true);
});

test('desktop: an unanswered card is removed at the idle time, and the compaction gets its question whole', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  // Due 52 minutes after the request that put the card up.
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  await f.clock.advance(52 * MIN - 1);
  expect(f.aborts).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
  expect(f.logs.at(-1)).toBe(`warm-compact: the question waited 52 min without an answer; the card was removed to compact the session while the cache is warm. Answer it in a message: ${QUOTED}`);
  // The aborted turn ends as any other: its end arms the timer, already due.
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  // What reached the compaction: the mod's note, the question whole in it.
  expect(f.compactions.length).toBe(1);
  expect(f.compactions[0]).toContain('ran automatically');
  expect(f.compactions[0]).toContain(`the user's next message may answer it: ${FULL}`);
  // The watch owned the long turn: no note that it did not end.
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
  await f.clock.advance(2 * HOUR);
  expect(f.aborts.length).toBe(1);
});

test('a card answered in time is not removed, and the turn end arms as usual', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  await f.clock.advance(30 * MIN);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
  // The model reads the answer and works on past the card's time.
  for await (const _ of $.turn.step({ turnId, index: 1, model: 'test', messageCount: 3 })) { /* drain */ }
  await f.clock.advance(25 * MIN);
  expect(f.aborts).toEqual([]);
  await ended($, turnId, 'answer');
  await f.clock.advance(27 * MIN - 1);
  expect(f.commands).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([]);
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(f.compactions[0]).not.toContain(QUESTION.question);
});

test('a card in a context under the floor passes through', async ($, on) => {
  const f = fixture(on, { tokens: 150_000 });
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
});

test('a card a subagent asks passes through', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f, 'a1');
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
});

test('a card in a headless run passes through', async ($, on) => {
  const f = fixture(on, { surfaces: [] });
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
  expect(stored(f)).toEqual([]);
});

// Another plugin asking the person: `$.ui.ask` runs the AskUserQuestion tool as its call.
const ASKER: Plugin = {
  name: 'asker',
  register(on) {
    on('prompt.submit', async ($, e, next) => {
      if (e.text !== 'ask') return next(e);
      return { drop: `asker: ${await $.ui.ask('Which date library should we use?', ['date-fns', 'dayjs'])}` };
    });
  },
};

test("another plugin's question passes through: it is not the turn's", { plugins: [ASKER] }, async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await requestInTurn($);
  const reply = $.prompt.submit({ text: 'ask', origin: { kind: 'composer' } } as never);
  await f.clock.settle();
  await f.clock.advance(120 * MIN);
  await passedThrough(f, reply, { drop: 'asker: dayjs' });
});

test('a card that goes up 50 minutes after its request stays 5 minutes before it is removed', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const turnId = await requestInTurn($);
  // A long tool of the same answer ran first.
  await f.clock.advance(50 * MIN);
  const call = ask($);
  await f.clock.settle();
  expect(f.logs).toEqual([watching(NOW + 55 * MIN)]);
  await f.clock.advance(5 * MIN - 1);
  expect(f.aborts).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
  expect(f.logs.at(-1)).toContain('the question waited 5 min without an answer');
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
});

test('a card that goes up 51 minutes after its request is removed at 56, a minute before the cutoff', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const turnId = await requestInTurn($);
  await f.clock.advance(51 * MIN);
  const call = ask($);
  await f.clock.settle();
  expect(f.logs).toEqual([watching(NOW + 56 * MIN)]);
  await f.clock.advance(5 * MIN - 1);
  expect(f.aborts).toEqual([]);
  await f.clock.advance(1);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
  // The compaction the removal starts begins before the cutoff.
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  await compactTurn($, f);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['compacted', 'idle']]);
});

test('a card that goes up a second later is not watched: less than a minute would be left before the cutoff', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await requestInTurn($);
  await f.clock.advance(51 * MIN + 1000);
  const call = ask($);
  await f.clock.settle();
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
});

test('a card that goes up 53 minutes after its request is not watched: removed in time, the cache would be cold', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await requestInTurn($);
  await f.clock.advance(53 * MIN);
  const call = ask($);
  await f.clock.settle();
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
});

test('a card that goes up as someone else compacts is not watched: its removal would compact nothing', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await requestInTurn($);
  // The watch reads the usage late; another plugin compacts the conversation meanwhile, and it stays large.
  f.world.lag = { 'session.usage': MIN };
  const call = ask($);
  await f.clock.settle();
  await $.session.compact({ trigger: 'manual', messages: SUMMARY });
  f.world.tokens = 300_000;
  await f.clock.advance(MIN);
  await f.clock.advance(120 * MIN);
  await passedThrough(f, call);
});

test('a card whose timer fires after the computer slept is left up: the cache is cold', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  // The computer sleeps 70 minutes as the card's timer fires.
  f.world.lag = { 'session.id': 70 * MIN };
  await f.clock.advance(52 * MIN);
  await f.clock.advance(70 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'card: late: the cache went cold while waiting']]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('a card whose timer fires in the last minute before the cutoff is left up: its compaction would start too late', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  // The computer sleeps 4.5 minutes as the card's timer fires: it reads 56.5 minutes.
  f.world.lag = { 'session.id': 4.5 * MIN };
  await f.clock.advance(52 * MIN);
  await f.clock.advance(4.5 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'card: late: the cache went cold while waiting']]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('with the cutoff a minute after the idle time, a card that goes up at once is still removed', { options: { idleMinutes: 52, cutoffMinutes: 53 } }, async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
});

test('a card with agents still running is left up, and noted', async ($, on) => {
  const f = fixture(on, { agents: [{ id: 'a1', description: 'scan', type: 'Explore', status: 'running' } as AgentInfo] });
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  await f.clock.advance(120 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'card: 1 agent(s) still running']]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('another tool of the turn still running keeps the card: ending the turn would stop it too', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await requestInTurn($);
  const tool = $.tool.call({ tool: 'Bash', command: 'sleep 9999' });
  const call = ask($);
  await f.clock.settle();
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'card: another tool of the turn is still running']]);
  expect(f.open.size).toBe(2);
  answer(f, ANSWERED, 'AskUserQuestion');
  expect(await call).toEqual(ANSWERED);
  answer(f, { result: 'done', text: 'done' }, 'Bash');
  await tool;
});

test('a tool of the turn that ended before the card does not keep it', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const turnId = await requestInTurn($);
  const tool = $.tool.call({ tool: 'Bash', command: 'ls' });
  await f.clock.settle();
  answer(f, { result: 'done', text: 'done' }, 'Bash');
  await tool;
  const call = ask($);
  await f.clock.settle();
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([turnId]);
  expect(await call).toEqual(ABORTED);
});

test('a usage limit used up by the removal time keeps the card, and is noted', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  f.world.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + 3 * HOUR) }];
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', 'card: the five_hour usage limit is used up']]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('a limit that reset before the removal time, or one short of 100, does not keep the card', async ($, on) => {
  const f = fixture(on, { rateLimits: [
    // Used up when the card went up; reset 42 minutes before its removal time.
    { kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + 10 * MIN) },
    { kind: 'seven_day', percentUsed: 99.9, resetsAt: iso(NOW + 72 * HOUR) },
  ] });
  await $.session.start(DESKTOP);
  const { turnId } = await askInTurn($, f);
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([turnId]);
});

test('a context under the floor by the removal time keeps the card', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  f.world.tokens = 150_000;
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([]);
  expect(stored(f)).toEqual([]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('off leaves a card up, whether turned off before it went up or while it waits', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await command($, 'off');
  const first = await askInTurn($, f);
  await passedThrough(f, first.call);
  await ended($, first.turnId, 'answer');
  await command($, 'on');
  const second = await askInTurn($, f);
  expect(f.logs).toEqual([watching(f.clock.now() + 52 * MIN)]);
  await command($, 'off');
  await f.clock.advance(120 * MIN);
  expect(f.aborts).toEqual([]);
  answer(f, ANSWERED);
  expect(await second.call).toEqual(ANSWERED);
});

test('off while the removal reads keeps the card', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  // The removal waits on the agents' list; the person turns the mod off meanwhile.
  f.world.lag = { 'agent.list': MIN };
  await f.clock.advance(52 * MIN);
  await command($, 'off');
  await f.clock.advance(MIN);
  expect(f.aborts).toEqual([]);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
});

test('a card answered while the removal reads is not removed, and no later note carries it', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  f.world.lag = { 'agent.list': MIN };
  await f.clock.advance(52 * MIN);
  answer(f, ANSWERED);
  expect(await call).toEqual(ANSWERED);
  await f.clock.advance(MIN);
  expect(f.aborts).toEqual([]);
  for await (const _ of $.turn.step({ turnId, index: 1, model: 'test', messageCount: 3 })) { /* drain */ }
  await ended($, turnId, 'answer');
  await f.clock.advance(52 * MIN);
  await compactTurn($, f);
  expect(f.compactions.length).toBe(1);
  expect(f.compactions[0]).not.toContain(QUESTION.question);
});

test('several cards of one turn: one removal, every unanswered question in the line and the note', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const turnId = await requestInTurn($);
  const date = ask($, [QUESTION]);
  const runner = ask($, [RUNNER]);
  const ship = ask($, [SHIP]);
  await f.clock.settle();
  // They share the removal time: one line.
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  await f.clock.advance(10 * MIN);
  // One answered: the others still wait, and are still watched.
  answer(f, ANSWERED, RUNNER.question);
  expect(await runner).toEqual(ANSWERED);
  await f.clock.advance(42 * MIN);
  expect(f.aborts).toEqual([turnId]);
  expect(await date).toEqual(ABORTED);
  expect(await ship).toEqual(ABORTED);
  expect(f.logs.at(-1)).toContain(`Answer it in a message: ${QUOTED}; ${SHIP_QUOTED}`);
  expect(f.logs.at(-1)).not.toContain(RUNNER.question);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  await compactTurn($, f);
  expect(f.compactions[0]).toContain(`${FULL} ${SHIP_FULL}`);
  expect(f.compactions[0]).not.toContain(RUNNER.question);
  await f.clock.advance(2 * HOUR);
  expect(f.aborts.length).toBe(1);
});

test('a /clear as the turn ends leaves no line about the removed card', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await askInTurn($, f);
  f.world.onAbort = () => { f.world.sessionId = 'next-session'; };
  await f.clock.advance(52 * MIN);
  expect(f.aborts.length).toBe(1);
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
});

test('the card texts in Russian when configured', RU, async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId } = await askInTurn($, f);
  const due = clockTime(NOW + 52 * MIN);
  expect(f.logs).toEqual([`warm-compact: карточка с вопросом ждёт ответа; если не ответить до ${due}, она будет снята, а сессия сжата, пока кэш тёплый.`]);
  expect((await command($, 'status')).text).toContain(`Ждёт ответа на карточку с вопросом: без ответа она будет снята в ${due}, затем сессия сжата.`);
  await f.clock.advance(52 * MIN);
  expect(f.logs.at(-1)).toBe(`warm-compact: вопрос ждал ответа 52 мин; карточка снята, чтобы сжать сессию, пока кэш тёплый. Ответьте на него сообщением: ${QUOTED}`);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  await compactTurn($, f);
  expect(f.compactions[0]).toContain('следующее сообщение пользователя может быть ответом на него: Library: "Which date library should we use?" (один ответ), варианты: "date-fns" — Tree-shakes; "dayjs" — Smallest.');
});

test('the session line: each question with its option labels, on one line, a long one cut', () => {
  expect(questionLine([QUESTION, { question: 'Ship\n  it now?', options: [{ label: 'Yes' }, { label: 'No' }] }])).toBe(`${QUOTED}; "Ship it now?" (Yes / No)`);
  const long = questionLine([{ question: 'x'.repeat(3000), options: [{ label: 'A' }, { label: 'B' }] }]);
  expect(long.length).toBe(1500);
  expect(long.endsWith('xx…')).toBe(true);
  expect(questionLine([])).toBe('');
});

test('the note: each question whole, with its header, every option described, one or several answers, a long one cut', () => {
  expect(questionNote(settings({}), [QUESTION, RUNNER])).toBe(`${FULL} ${RUNNER_FULL}`);
  expect(questionNote(settings({ language: 'ru' }), [RUNNER])).toBe('Runner: "Which test runner?" (можно несколько ответов), варианты: "vitest" — Fast; "jest" — Known.');
  const long = questionNote(settings({}), [{ ...QUESTION, question: 'y'.repeat(5000) }]);
  expect(long.length).toBe(4000);
  expect(long.endsWith('yy…')).toBe(true);
});

test('status names the time a card is removed', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { call } = await askInTurn($, f);
  expect((await command($, 'status')).text).toContain(`Waiting on a question card: removed at ${clockTime(NOW + 52 * MIN)} if unanswered, then compacted.`);
  answer(f, ANSWERED);
  await call;
  expect((await command($, 'status')).text).toContain('A turn is running');
});

test('terminal: the direct call carries the removed question, and the next compaction does not', async ($, on) => {
  const f = fixture(on, { surfaces: ['terminal'] });
  await $.session.start(TERMINAL);
  const { turnId } = await askInTurn($, f);
  await f.clock.advance(52 * MIN);
  expect(f.aborts).toEqual([turnId]);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  expect(f.direct.length).toBe(1);
  expect(f.direct[0]).toContain(FULL);
  expect(stored(f)[0]?.outcome).toBe('compacted');
  // Compacted with it: the summary holds it now.
  await command($, 'now');
  await f.clock.advance(1000);
  expect(f.direct.length).toBe(2);
  expect(f.direct[1]).not.toContain(QUESTION.question);
});

test('a turn the engine would not end leaves the card up, noted, its question out of the next note', async ($, on) => {
  const f = fixture(on, { failAbort: true });
  await $.session.start(DESKTOP);
  const { turnId, call } = await askInTurn($, f);
  await f.clock.advance(52 * MIN);
  expect(stored(f).map(e => [e.outcome, e.reason])).toEqual([['noted', expect.stringMatching(new RegExp(`^card: the turn was not ended: .*${turnId} is not the running turn$`))]]);
  expect(f.logs).toEqual([watching(NOW + 52 * MIN)]);
  // Answered later; the turn ends before another request, and its end compacts at once.
  answer(f, ANSWERED);
  await call;
  await ended($, turnId, 'answer');
  await f.clock.settle();
  expect(f.commands.length).toBe(1);
  await compactTurn($, f);
  expect(f.compactions[0]).not.toContain(QUESTION.question);
});

test('a vetoed /compact keeps the question for the next compaction, and one that compacted with it drops it', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId } = await askInTurn($, f);
  await f.clock.advance(52 * MIN);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  // The queued /compact started past the cutoff: vetoed, the cache went cold.
  await f.clock.advance(6 * MIN);
  await compactTurn($, f);
  expect(stored(f).map(e => e.reason)).toEqual(['vetoed: late: the cache went cold while waiting']);
  expect(f.compactions).toEqual([]);
  // By hand: the summary still gets the question.
  await command($, 'now');
  await f.clock.advance(1000);
  await compactTurn($, f);
  expect(f.compactions.length).toBe(1);
  expect(f.compactions[0]).toContain(FULL);
  // Compacted with it: the next one does not repeat it.
  await command($, 'now');
  await f.clock.advance(1000);
  await compactTurn($, f);
  expect(f.compactions.length).toBe(2);
  expect(f.compactions[1]).not.toContain(QUESTION.question);
});

test('a model request drops the question: the conversation moved on', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  const { turnId } = await askInTurn($, f);
  await f.clock.advance(52 * MIN);
  await ended($, turnId, 'aborted');
  await f.clock.settle();
  // The person's message runs before the queued /compact, which then has nothing to do.
  await turn($, f.clock);
  await compactTurn($, f);
  expect(stored(f).map(e => e.reason)).toEqual(['vetoed: a turn ran first']);
  await f.clock.advance(52 * MIN);
  await compactTurn($, f);
  expect(f.compactions.length).toBe(1);
  expect(f.compactions[0]).not.toContain(QUESTION.question);
});
