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
    summarySaved: ' Summary saved: {file}',
    skipLate: 'warm-compact: not compacted, the timer fired {idle} min after the last request (the computer slept?): the cache is cold already.',
    skipSmall: 'warm-compact: not compacted, the context is {tokens} tokens, under {min}.',
    skipAgents: 'warm-compact: not compacted, {n} agent(s) still running.',
    skipLimited: 'warm-compact: not compacted, the {kind} usage limit is used up and has not reset yet.',
    vetoed: 'warm-compact: compaction skipped: {reason}.',
    failed: 'warm-compact: compaction failed: {reason}.',
    outcomeCompacted: 'compacted',
    outcomeSkipped: 'skipped',
    outcomeFailed: 'failed',
    outcomeNoted: 'noted',
    instructions: 'This compaction ran automatically at {time}, after {idle} minutes without a model request, before the one-hour prompt cache expired. Open the summary by saying so. Write it as a note for continuing the work: the goal; what is done; what is left and the next step; files touched; decisions and permissions the user gave, with their reasons; rejected options, briefly, and why they were rejected; the exact paths, file names, commands, commits, identifiers and numbers needed to continue and verify the work, not rounded or paraphrased, leaving out intermediate and repeated ones; background processes, agents and waits still open; what was not verified; dates and deadlines.',
    instructionsManual: 'This compaction was started by hand with /warm-compact now at {time}. Open the summary by saying so. Write it as a note for continuing the work: the goal; what is done; what is left and the next step; files touched; decisions and permissions the user gave, with their reasons; rejected options, briefly, and why they were rejected; the exact paths, file names, commands, commits, identifiers and numbers needed to continue and verify the work, not rounded or paraphrased, leaving out intermediate and repeated ones; background processes, agents and waits still open; what was not verified; dates and deadlines.',
    openQuestion: 'The last turn ended on a question to the user, or several, never answered: the cards were removed for this compaction. Quote each word for word as an open question, with its header, every option with its description, and whether several answers are allowed; the user\'s next message may answer it: {question}',
    oneAnswer: 'one answer',
    manyAnswers: 'several answers allowed',
    optionsWord: 'options',
    cardNotice: 'warm-compact: a question card waits for an answer; if it is not answered by {time}, it is removed and the session compacted while the cache is warm.',
    cardRemoved: 'warm-compact: the question waited {idle} min without an answer; the card was removed to compact the session while the cache is warm. Answer it in a message: {question}',
    cardPending: 'Waiting on a question card: removed at {time} if unanswered, then compacted.',
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
    summarySaved: ' Сводка сохранена: {file}',
    skipLate: 'warm-compact: не сжато, таймер сработал через {idle} мин после последнего запроса (компьютер спал?): кэш уже остыл.',
    skipSmall: 'warm-compact: не сжато, контекст {tokens} токенов, меньше {min}.',
    skipAgents: 'warm-compact: не сжато, ещё работают агенты: {n}.',
    skipLimited: 'warm-compact: не сжато, лимит {kind} исчерпан и ещё не сброшен.',
    vetoed: 'warm-compact: сжатие пропущено: {reason}.',
    failed: 'warm-compact: сжатие не удалось: {reason}.',
    outcomeCompacted: 'сжато',
    outcomeSkipped: 'пропущено',
    outcomeFailed: 'не удалось',
    outcomeNoted: 'отмечено',
    instructions: 'Это сжатие запущено автоматически в {time}, после {idle} минут без запросов к модели, до протухания часового промт-кэша. Начни резюме с этого. Пиши её как записку для продолжения работы: цель; что сделано; что осталось и следующий шаг; тронутые файлы; решения и разрешения пользователя с причинами; отвергнутые варианты, коротко, и почему от них отказались; точные пути, имена файлов, команды, коммиты, идентификаторы и числа, нужные для продолжения и проверки, без округления и пересказа, а промежуточные и повторы опускай; незавершённые фоновые процессы, агенты и ожидания; что не проверено; даты и сроки.',
    instructionsManual: 'Это сжатие запущено вручную командой /warm-compact now в {time}. Начни резюме с этого. Пиши её как записку для продолжения работы: цель; что сделано; что осталось и следующий шаг; тронутые файлы; решения и разрешения пользователя с причинами; отвергнутые варианты, коротко, и почему от них отказались; точные пути, имена файлов, команды, коммиты, идентификаторы и числа, нужные для продолжения и проверки, без округления и пересказа, а промежуточные и повторы опускай; незавершённые фоновые процессы, агенты и ожидания; что не проверено; даты и сроки.',
    openQuestion: 'Последний ход закончился вопросом пользователю (или несколькими), на который так и не ответили: карточки сняли ради этого сжатия. Приведи каждый дословно как открытый вопрос, с заголовком, всеми вариантами и их описаниями и пометкой, можно ли выбрать несколько; следующее сообщение пользователя может быть ответом на него: {question}',
    oneAnswer: 'один ответ',
    manyAnswers: 'можно несколько ответов',
    optionsWord: 'варианты',
    cardNotice: 'warm-compact: карточка с вопросом ждёт ответа; если не ответить до {time}, она будет снята, а сессия сжата, пока кэш тёплый.',
    cardRemoved: 'warm-compact: вопрос ждал ответа {idle} мин; карточка снята, чтобы сжать сессию, пока кэш тёплый. Ответьте на него сообщением: {question}',
    cardPending: 'Ждёт ответа на карточку с вопросом: без ответа она будет снята в {time}, затем сессия сжата.',
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

/** The note to the summarizer; `question`: the questions of the cards removed for it, never answered. */
export function instructions(cfg: Config, time: string, idleMinutes: number, manual: boolean, question?: string): string {
  const parts = [t(cfg, manual ? 'instructionsManual' : 'instructions', { time, idle: idleMinutes })];
  if (question !== undefined) parts.push(t(cfg, 'openQuestion', { question }));
  if (cfg.hint) parts.push(cfg.hint);
  return parts.join(' ');
}

// The questions go into a line in the session, short, and into the note in full: a long text is cut.
const LINE_MAX = 1500;
const NOTE_MAX = 4000;

type Asked = { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
type Option = { label?: unknown; description?: unknown };

function oneLine(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function asked(questions: readonly unknown[]): Asked[] {
  return questions.filter((q): q is Asked => typeof q === 'object' && q !== null);
}

function options(q: Asked): Option[] {
  return Array.isArray(q.options) ? q.options.filter((o): o is Option => typeof o === 'object' && o !== null) : [];
}

function cut(text: string, max: number): string {
  // Not cut inside a character outside the BMP (an emoji): half of it would not encode.
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : text;
}

/** The cards' questions for the session line: each with its option labels, `"Which one?" (A / B)`. */
export function questionLine(questions: readonly unknown[]): string {
  const text = asked(questions)
    .map(q => {
      const labels = options(q).map(o => oneLine(o.label)).filter(Boolean);
      return labels.length ? `"${oneLine(q.question)}" (${labels.join(' / ')})` : `"${oneLine(q.question)}"`;
    })
    .join('; ');
  return cut(text, LINE_MAX);
}

/** The cards' questions for the summarizer, whole: header, question, one or several answers, each option with its description. */
export function questionNote(cfg: Config, questions: readonly unknown[]): string {
  const text = asked(questions)
    .map(q => {
      const header = oneLine(q.header);
      const answers = t(cfg, q.multiSelect === true ? 'manyAnswers' : 'oneAnswer');
      const list = options(q).map(o => {
        const description = oneLine(o.description);
        return description ? `"${oneLine(o.label)}" — ${description}` : `"${oneLine(o.label)}"`;
      });
      return `${header ? `${header}: ` : ''}"${oneLine(q.question)}" (${answers}), ${t(cfg, 'optionsWord')}: ${list.join('; ')}.`;
    })
    .join(' ');
  return cut(text, NOTE_MAX);
}
