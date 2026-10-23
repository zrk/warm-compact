import type { AgentInfo, On, SessionRateLimit } from 'claude-code';
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing';
import { isHeadlessRefusal } from '../hooks/register.ts';
import { settings } from '../hooks/text.ts';

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
};

function fixture(on: On, initial: Partial<World> = {}) {
  const clock = mock.clock(on, { now: NOW });
  const store = new Map<string, unknown>();
  on('store.get', ($, e) => ({ value: store.get(e.key) }));
  on('store.set', ($, e) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined }; });
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined }; });
  const world: World = { tokens: 300_000, agents: [], surfaces: ['desktop'], rateLimits: [], ...initial };
  const logs: string[] = [];
  const commands: { command: string; args?: string }[] = [];
  const direct: (string | undefined)[] = [];
  on('session.id', () => ({ value: 'test-session' }));
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: world.tokens, window: 1_000_000 }, rateLimits: world.rateLimits } }));
  on('agent.list', () => ({ value: world.agents }));
  on('session.surfaces', () => ({ value: world.surfaces as never }));
  on('command.register', () => ({ value: { command: 'warm-compact' } }));
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined }; });
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  on('session.compact', ($, e) => {
    // A compaction outside a /compact turn is the mod's direct call.
    if (world.pending === undefined) {
      direct.push(e.instructions);
    }
    const before = world.tokens;
    world.tokens = 20_000;
    return { messages: SUMMARY, tokensBefore: before, tokensAfter: 15_000, usage: { input_tokens: 10, cache_read_input_tokens: 290_000, cache_creation_input_tokens: 9_990, output_tokens: 4_000 } };
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
  return { clock, world, logs, commands, direct, store };
}

const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }] as never;

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

function stored(f: Fixture) {
  return (f.store.get('log') ?? []) as { outcome: string; reason: string; tokensBefore?: number; tokensAfter?: number; cacheShare?: number }[];
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
  const log = stored(f);
  expect(log.length).toBe(1);
  expect(log[0]?.outcome).toBe('skipped');
  expect(log[0]?.reason).toBe('late');
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

test('/clear cancels the timer', async ($, on) => {
  const f = fixture(on);
  await $.session.start(DESKTOP);
  await turn($, f.clock);
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { sessionId: 'test-session' } } as never);
  await f.clock.advance(60 * MIN);
  expect(f.commands).toEqual([]);
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
  expect((reply as { drop?: string }).drop).toContain('warm-compact 0.1.0');
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
