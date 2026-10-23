// Settings from the manifest's userConfig, resolved once per load, and every
// text the mod shows or hands to the summarizer, in the configured language.
import type { ModelUsage, PluginOptions } from 'claude-code';

export type Config = {
  lang: 'en' | 'ru';
  idleMs: number;
  cutoffMs: number;
  minTokens: number;
  hint: string;
};

const DEFAULT_IDLE = 52;
const DEFAULT_CUTOFF = 57;
const DEFAULT_MIN_TOKENS = 200_000;
const MAX_IDLE = 58;
const MAX_CUTOFF = 59;

function number(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function settings(options: PluginOptions = {}): Config {
  // The cache lives an hour: both times stay under it, the cutoff after the idle time.
  let idle = number(options.idleMinutes) ?? DEFAULT_IDLE;
  if (idle > MAX_IDLE) idle = DEFAULT_IDLE;
  let cutoff = number(options.cutoffMinutes) ?? DEFAULT_CUTOFF;
  if (cutoff <= idle || cutoff > MAX_CUTOFF) cutoff = Math.min(Math.max(DEFAULT_CUTOFF, idle + 1), MAX_CUTOFF);
  return {
    lang: options.language === 'ru' ? 'ru' : 'en',
    idleMs: idle * 60_000,
    cutoffMs: cutoff * 60_000,
    minTokens: number(options.minTokens) ?? DEFAULT_MIN_TOKENS,
    hint: String(options.noteHint ?? '').trim(),
  };
}

const MESSAGES = {
  en: {
    commandDescription: 'Compact this session when it idles before the prompt cache expires: status, now, off, on',
    commands: 'Commands: /warm-compact status, /warm-compact now, /warm-compact off, /warm-compact on.',
    status: 'warm-compact {version}: {state} in this session. Compacts {idle} min after the last model request when the context is at least {min} tokens; a timer later than {cutoff} min skips. {armed}',
    on: 'on',
    off: 'off',
    armedAt: 'Armed: compacts at {time} ({tokens} tokens now).',
    working: 'A turn is running: the timer is armed when it ends.',
    compactingNow: 'Compacting now.',
    notArmed: 'Not armed: {why}.',
    noRequest: 'no model request since the mod loaded',
    small: 'the context is {tokens} tokens, under {min}',
    offHere: 'off in this session',
    recent: 'Recent in this session:',
    none: 'Nothing compacted or skipped in this session yet.',
    turnedOff: 'warm-compact is off in this session.',
    turnedOn: 'warm-compact is on in this session.',
    busy: 'A turn is running. Run /warm-compact now when it ends.',
    nowScheduled: 'Compacting in a moment.',
    compacted: 'warm-compact: compacted at {time} after {idle} min idle, {before} tokens → {after}{cache}.',
    cacheShare: ', {pct}% of the summary input read from cache',
    skipLate: 'warm-compact: not compacted, the timer fired {idle} min after the last request (the computer slept?): the cache is cold already.',
    skipSmall: 'warm-compact: not compacted, the context is {tokens} tokens, under {min}.',
    skipAgents: 'warm-compact: not compacted, {n} agent(s) still running.',
    skipLimited: 'warm-compact: not compacted, the {kind} usage limit is used up and has not reset yet.',
    vetoed: 'warm-compact: compaction skipped: {reason}.',
    failed: 'warm-compact: compaction failed: {reason}.',
    outcomeCompacted: 'compacted',
    outcomeSkipped: 'skipped',
    outcomeFailed: 'failed',
    instructions: 'This compaction ran automatically at {time}, after {idle} minutes without a model request, before the one-hour prompt cache expired. Open the summary by saying so. Write it as a note for continuing the work: the goal; what is done; what is left and the next step; files touched; decisions and permissions the user gave, with their reasons; background processes, agents and waits still open; what was not verified; dates and deadlines.',
    instructionsManual: 'This compaction was started by hand with /warm-compact now at {time}. Open the summary by saying so. Write it as a note for continuing the work: the goal; what is done; what is left and the next step; files touched; decisions and permissions the user gave, with their reasons; background processes, agents and waits still open; what was not verified; dates and deadlines.',
  },
  ru: {
    commandDescription: 'Сжимать сессию в простое до протухания кэша: status, now, off, on',
    commands: 'Команды: /warm-compact status, /warm-compact now, /warm-compact off, /warm-compact on.',
    status: 'warm-compact {version}: в этой сессии {state}. Сжимает через {idle} мин после последнего запроса к модели, если контекст не меньше {min} токенов; таймер позже {cutoff} мин пропускает. {armed}',
    on: 'включён',
    off: 'выключен',
    armedAt: 'Взведён: сожмёт в {time} (сейчас {tokens} токенов).',
    working: 'Идёт ход: таймер взведётся по его окончании.',
    compactingNow: 'Идёт сжатие.',
    notArmed: 'Не взведён: {why}.',
    noRequest: 'с загрузки мода не было запросов к модели',
    small: 'контекст {tokens} токенов, меньше {min}',
    offHere: 'выключен в этой сессии',
    recent: 'Последнее в этой сессии:',
    none: 'В этой сессии ещё ничего не сжималось и не пропускалось.',
    turnedOff: 'warm-compact выключен в этой сессии.',
    turnedOn: 'warm-compact включён в этой сессии.',
    busy: 'Идёт ход. Запустите /warm-compact now, когда он закончится.',
    nowScheduled: 'Сжатие через мгновение.',
    compacted: 'warm-compact: сжато в {time} после {idle} мин тишины, {before} токенов → {after}{cache}.',
    cacheShare: ', {pct}% входа резюме прочитано из кэша',
    skipLate: 'warm-compact: не сжато, таймер сработал через {idle} мин после последнего запроса (компьютер спал?): кэш уже остыл.',
    skipSmall: 'warm-compact: не сжато, контекст {tokens} токенов, меньше {min}.',
    skipAgents: 'warm-compact: не сжато, ещё работают агенты: {n}.',
    skipLimited: 'warm-compact: не сжато, лимит {kind} исчерпан и ещё не сброшен.',
    vetoed: 'warm-compact: сжатие пропущено: {reason}.',
    failed: 'warm-compact: сжатие не удалось: {reason}.',
    outcomeCompacted: 'сжато',
    outcomeSkipped: 'пропущено',
    outcomeFailed: 'не удалось',
    instructions: 'Это сжатие запущено автоматически в {time}, после {idle} минут без запросов к модели, до протухания часового промт-кэша. Начни резюме с этого. Пиши её как записку для продолжения работы: цель; что сделано; что осталось и следующий шаг; тронутые файлы; решения и разрешения пользователя с причинами; незавершённые фоновые процессы, агенты и ожидания; что не проверено; даты и сроки.',
    instructionsManual: 'Это сжатие запущено вручную командой /warm-compact now в {time}. Начни резюме с этого. Пиши её как записку для продолжения работы: цель; что сделано; что осталось и следующий шаг; тронутые файлы; решения и разрешения пользователя с причинами; незавершённые фоновые процессы, агенты и ожидания; что не проверено; даты и сроки.',
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.en;

export function t(cfg: Config, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[cfg.lang][key].replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

export function clockTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

export function tokens(n: number | undefined): string {
  if (n === undefined) return '?';
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`;
}

/** Share of the summary request's input served by the prompt cache, 0 to 100. */
export function cachePercent(usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return input ? Math.floor((usage.cache_read_input_tokens * 100) / input) : undefined;
}

export function instructions(cfg: Config, time: string, idleMinutes: number, manual: boolean): string {
  const base = t(cfg, manual ? 'instructionsManual' : 'instructions', { time, idle: idleMinutes });
  return cfg.hint ? `${base} ${cfg.hint}` : base;
}
