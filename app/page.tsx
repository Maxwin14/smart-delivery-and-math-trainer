'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Delete as DeleteIcon,
  Lightbulb,
  Play,
  RotateCcw,
  Timer,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
type SymbolKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '+' | '-' | '×' | '÷';
type KeypadKey = SymbolKey | '(' | ')';
type Inventory = Record<SymbolKey, number>;
type Feedback = { kind: 'idle' | 'success' | 'error' | 'info'; message: string };
type Difficulty = 'lower' | 'upper';
type HistoryEntry = { id: number; equation: string; correct: boolean };
type ToolRegistration = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};
type ModelContext = {
  registerTool: (tool: ToolRegistration, options?: { signal?: AbortSignal }) => void | Promise<void>;
};

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const OPERATORS = ['+', '-', '×', '÷'] as const;
const KEYPAD_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
const TIMER_SECONDS = 3 * 60;
const LOWER_TARGETS = [7, 8, 9, 12, 14, 16, 18, 21, 23, 24, 27, 31, 34, 37, 42, 45, 48, 52, 56, 63, 68, 71, 76, 81, 84, 92, 96, 98];
const chipColors = ['rose', 'amber', 'green', 'blue', 'violet', 'pink', 'orange', 'teal', 'indigo', 'purple'];

const makeInventory = (): Inventory => ({
  '0': 8, '1': 8, '2': 8, '3': 8, '4': 8,
  '5': 8, '6': 8, '7': 8, '8': 8, '9': 8,
  '+': 10, '-': 10, '×': 10, '÷': 10,
});

function randomTarget(difficulty: Difficulty, previous?: number) {
  let next = previous;
  while (next === previous) {
    next = difficulty === 'lower'
      ? LOWER_TARGETS[Math.floor(Math.random() * LOWER_TARGETS.length)]
      : Math.floor(Math.random() * 189) + 11;
  }
  return next ?? 96;
}

function normalizeExpression(value: string) {
  return value.replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s/g, '');
}

function requiredChips(expression: string) {
  const counts = {} as Partial<Record<SymbolKey, number>>;
  for (const symbol of normalizeExpression(expression)) {
    if ([...DIGITS, ...OPERATORS].includes(symbol as SymbolKey)) {
      const key = symbol as SymbolKey;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function evaluateExpression(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  const expression = normalizeExpression(raw);
  if (!expression) return { ok: false, reason: 'Build an equation first.' };
  if (!/^[0-9+\-×÷()]+$/.test(expression)) {
    return { ok: false, reason: 'Use numbers, parentheses, and the four operators only.' };
  }

  let index = 0;
  let parseError = '';

  function parseFactor(): number {
    if (expression[index] === '(') {
      index += 1;
      const value = parseSum();
      if (expression[index] !== ')') {
        parseError = 'Check that every opening parenthesis has a closing parenthesis.';
        return Number.NaN;
      }
      index += 1;
      return value;
    }

    const start = index;
    while (/\d/.test(expression[index] ?? '')) index += 1;
    if (start === index) {
      parseError = 'Place a number or opening parenthesis here.';
      return Number.NaN;
    }
    return Number(expression.slice(start, index));
  }

  function parseProduct(): number {
    let value = parseFactor();
    while (expression[index] === '×' || expression[index] === '÷') {
      const operator = expression[index];
      index += 1;
      const next = parseFactor();
      if (operator === '÷' && next === 0) {
        parseError = 'Division by zero is not allowed.';
        return Number.NaN;
      }
      value = operator === '×' ? value * next : value / next;
    }
    return value;
  }

  function parseSum(): number {
    let value = parseProduct();
    while (expression[index] === '+' || expression[index] === '-') {
      const operator = expression[index];
      index += 1;
      const next = parseProduct();
      value = operator === '+' ? value + next : value - next;
    }
    return value;
  }

  const value = parseSum();
  if (parseError) return { ok: false, reason: parseError };
  if (index !== expression.length) {
    return { ok: false, reason: 'Check the order of numbers, operators, and parentheses.' };
  }

  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, reason: 'That equation cannot be calculated.' };
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function formatExpression(value: string) {
  return normalizeExpression(value).replace(/([+\-×÷])/g, ' $1 ');
}

function findFactorPair(value: number): [number, number] | null {
  for (let factor = Math.floor(Math.sqrt(value)); factor >= 2; factor -= 1) {
    if (value % factor === 0) return [factor, value / factor];
  }
  return null;
}

function playTone(success: boolean) {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = success ? 660 : 220;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch {
    // Audio feedback is optional.
  }
}

export default function Home() {
  const [target, setTarget] = useState(96);
  const [expression, setExpression] = useState('');
  const [inventory, setInventory] = useState<Inventory>(makeInventory);
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle', message: 'Use the keypad or tap chips to build an equation.' });
  const [timeLeft, setTimeLeft] = useState(TIMER_SECONDS);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timesUpOpen, setTimesUpOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const difficulty: Difficulty = 'lower';
  const soundOn = true;
  const historyIdRef = useRef(0);
  const toolActionsRef = useRef<{
    newNumber: () => number;
    resetAll: () => number;
    checkEquation: (value: string) => unknown;
  }>({
    newNumber: () => 96,
    resetAll: () => 96,
    checkEquation: (_value: string) => ({ status: 'idle', target: 96 }),
  });

  const selectedCounts = useMemo(() => requiredChips(expression), [expression]);
  const correctTotal = useMemo(() => history.reduce((total, entry) => total + Number(entry.correct), 0), [history]);
  const incorrectTotal = history.length - correctTotal;

  useEffect(() => {
    if (!timerRunning) return;
    const timerId = window.setInterval(() => {
      setTimeLeft((current) => {
        if (current <= 1) {
          window.clearInterval(timerId);
          setTimerRunning(false);
          setTimesUpOpen(true);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [timerRunning]);

  function resetTimer() {
    setTimerRunning(false);
    setTimeLeft(TIMER_SECONDS);
    setTimesUpOpen(false);
  }

  function startTimer() {
    if (timeLeft <= 0) return;
    setTimerRunning(true);
  }

  function startNewNumber() {
    const next = randomTarget(difficulty, target);
    setTarget(next);
    setExpression('');
    setFeedback({ kind: 'idle', message: 'New number ready. Build an equation.' });
    resetTimer();
    return next;
  }

  function resetAll() {
    const next = randomTarget(difficulty, target);
    setInventory(makeInventory());
    setExpression('');
    setTarget(next);
    setHistory([]);
    historyIdRef.current = 0;
    setFeedback({ kind: 'idle', message: 'Use the keypad or tap chips to build an equation.' });
    resetTimer();
    return next;
  }

  function appendChip(symbol: SymbolKey) {
    const pending = selectedCounts[symbol] ?? 0;
    if (pending >= inventory[symbol]) {
      setFeedback({ kind: 'error', message: `No more ${symbol} chips are available for this equation.` });
      return;
    }
    setExpression((current) => `${current}${symbol}`);
    setFeedback({ kind: 'idle', message: 'Keep building, then check your equation.' });
  }

  function clearEquation() {
    setExpression('');
    setFeedback({ kind: 'idle', message: 'Equation cleared. Your used chip stock is unchanged.' });
  }

  function deleteLastKey() {
    setExpression((current) => normalizeExpression(current).slice(0, -1));
    setFeedback({ kind: 'idle', message: 'Last key removed.' });
  }

  function appendKey(key: KeypadKey) {
    if (key === '(' || key === ')') {
      setExpression((current) => `${normalizeExpression(current)}${key}`.slice(0, 32));
      setFeedback({ kind: 'idle', message: 'Keep building, then check your equation.' });
      return;
    }
    appendChip(key);
  }

  function recordHistory(value: string, correct: boolean) {
    const normalized = normalizeExpression(value);
    if (!normalized) return;
    historyIdRef.current += 1;
    setHistory((current) => [...current, { id: historyIdRef.current, equation: formatExpression(normalized), correct }]);
  }

  function checkEquation(value = expression) {
    if (value !== expression) setExpression(value);
    if (timeLeft <= 0) {
      setFeedback({ kind: 'error', message: 'Time is up. Reset the timer or choose New Number to try another round.' });
      if (soundOn) playTone(false);
      return { status: 'time_up', target };
    }

    const normalized = normalizeExpression(value);
    if (!normalized) {
      setFeedback({ kind: 'error', message: 'Build an equation first.' });
      if (soundOn) playTone(false);
      return { status: 'invalid', target, reason: 'Build an equation first.' };
    }

    const needed = requiredChips(normalized);
    const missing = Object.entries(needed).find(([symbol, count]) => inventory[symbol as SymbolKey] < (count ?? 0));
    if (missing) {
      setFeedback({ kind: 'error', message: `This equation was not submitted because there are not enough ${missing[0]} chips available.` });
      if (soundOn) playTone(false);
      return { status: 'missing_chips', target, symbol: missing[0] };
    }

    setInventory((current) => {
      const next = { ...current };
      Object.entries(needed).forEach(([symbol, count]) => {
        next[symbol as SymbolKey] -= count ?? 0;
      });
      return next;
    });

    const result = evaluateExpression(value);
    if (!result.ok) {
      setFeedback({ kind: 'error', message: result.reason });
      recordHistory(value, false);
      setExpression('');
      if (soundOn) playTone(false);
      return { status: 'invalid', target, reason: result.reason };
    }

    if (Math.abs(result.value - target) > Number.EPSILON) {
      setFeedback({ kind: 'error', message: `${normalizeExpression(value)} = ${result.value}, not ${target}. Try another strategy.` });
      recordHistory(value, false);
      setExpression('');
      if (soundOn) playTone(false);
      return { status: 'incorrect', target, value: result.value };
    }
    setFeedback({ kind: 'success', message: `Correct! ${normalizeExpression(value)} = ${target}. The required chips have been used.` });
    recordHistory(value, true);
    setExpression('');
    if (soundOn) playTone(true);
    return { status: 'correct', target, expression: normalizeExpression(value) };
  }

  const tens = Math.floor(target / 10) * 10;
  const ones = target % 10;

  useEffect(() => {
    toolActionsRef.current = {
      newNumber: startNewNumber,
      resetAll,
      checkEquation,
    };
  });

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    const registrations: ToolRegistration[] = [
      {
        name: 'start_new_math_round',
        title: 'Start new maths round',
        description: 'Choose a new Math Answer, clear the equation, and reset the three-minute timer.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: () => ({ target: toolActionsRef.current.newNumber(), status: 'ready' }),
      },
      {
        name: 'reset_math_trainer',
        title: 'Reset maths trainer',
        description: 'Restore every chip and reset the current training round.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: () => ({ target: toolActionsRef.current.resetAll(), status: 'reset' }),
      },
      {
        name: 'check_math_equation',
        title: 'Check maths equation',
        description: 'Check an equation against the visible Math Answer and available chip stock.',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string', minLength: 3, maxLength: 32 } },
          required: ['expression'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: (input) => {
          const expressionValue = typeof input === 'object' && input !== null && 'expression' in input
            ? String((input as { expression: unknown }).expression)
            : '';
          if (!expressionValue || expressionValue.length > 32) throw new Error('A valid expression is required.');
          return toolActionsRef.current.checkEquation(expressionValue);
        },
      },
    ];

    registrations.forEach((registration) => {
      try {
        void Promise.resolve(context.registerTool(registration, { signal: lifecycle.signal })).catch(() => undefined);
      } catch {
        // WebMCP support is optional and feature-detected.
      }
    });
    return () => lifecycle.abort();
  }, []);

  return (
    <>
      <main className="trainer-shell">
        <section className="trainer-card" aria-labelledby="page-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">Practice workspace</p>
            <h1 id="page-title">Smart Delivery &amp; Maths Trainer</h1>
          </div>
          <div className="top-actions">
            <div className={`timer-control ${timeLeft <= 10 ? 'timer-control-warning' : ''}`} aria-label={`Timer ${formatTime(timeLeft)}`}>
              <Timer aria-hidden="true" />
              <strong>{formatTime(timeLeft)}</strong>
              <Button className="timer-button timer-start" onClick={startTimer} disabled={timerRunning || timeLeft === 0} size="lg">
                <Play aria-hidden="true" /> Start
              </Button>
              <Button className="timer-button" variant="outline" onClick={resetTimer} size="lg">
                Reset
              </Button>
            </div>
            <Button className="action-button" variant="outline" onClick={resetAll} size="lg">
              <RotateCcw aria-hidden="true" /> Reset All
            </Button>
          </div>
        </header>

        <section className="chip-layout" aria-label="Available chips">
          <ChipPanel title="Number Chips (0–9)" caption="8 chips each" tone="numbers">
            <div className="number-groups">
              {DIGITS.map((digit, colorIndex) => (
                <ChipRow
                  key={digit}
                  symbol={digit}
                  total={8}
                  available={inventory[digit]}
                  selected={selectedCounts[digit] ?? 0}
                  color={chipColors[colorIndex]}
                  onSelect={() => appendChip(digit)}
                />
              ))}
            </div>
          </ChipPanel>

          <ChipPanel title="Operator Chips" caption="10 chips each" tone="operators">
            <div className="operator-groups">
              {OPERATORS.map((operator, colorIndex) => (
                <ChipRow
                  key={operator}
                  symbol={operator}
                  total={10}
                  available={inventory[operator]}
                  selected={selectedCounts[operator] ?? 0}
                  color={['rose', 'amber', 'green', 'blue'][colorIndex]}
                  onSelect={() => appendChip(operator)}
                  operator
                />
              ))}
            </div>
          </ChipPanel>
        </section>

        <section className="answer-panel" aria-live="polite">
          <div className="answer-copy">
            <div className="answer-label-row">
              <span className="answer-label">Math Answer</span>
            </div>
            <strong className="answer-number">{target}</strong>
          </div>
          <Button className="answer-new-button" variant="outline" onClick={startNewNumber} aria-label="Choose a new math answer">
            <DiceCubeIcon />
            <span>New<br />Number</span>
          </Button>
        </section>

        <section className="equation-panel" aria-label="Equation builder">
          <div className="equation-row">
            <output className={`equation-display ${expression ? '' : 'equation-display-empty'}`} aria-label="Current equation">
              {expression ? formatExpression(expression) : 'Build your equation with the keypad'}
            </output>
            <Button className="check-button" onClick={() => checkEquation()} size="lg">
              <Check aria-hidden="true" /> Check
            </Button>
          </div>

          <output className={`feedback feedback-${feedback.kind}`} aria-live="polite">{feedback.message}</output>

          <div className="equation-keypad" aria-label="Equation keypad">
            {KEYPAD_NUMBERS.map((key) => (
              <button
                type="button"
                className="keypad-key"
                key={key}
                onClick={() => appendKey(key)}
                disabled={(selectedCounts[key] ?? 0) >= inventory[key]}
                aria-label={`Add ${key}`}
              >
                {key}
              </button>
            ))}
            {OPERATORS.map((key) => (
              <button
                type="button"
                className="keypad-key keypad-operator"
                key={key}
                onClick={() => appendKey(key)}
                disabled={(selectedCounts[key] ?? 0) >= inventory[key]}
                aria-label={`Add ${key}`}
              >
                {key === '-' ? '−' : key}
              </button>
            ))}
            <button type="button" className="keypad-key" onClick={() => appendKey('(')} aria-label="Add opening parenthesis">(</button>
            <button type="button" className="keypad-key" onClick={() => appendKey(')')} aria-label="Add closing parenthesis">)</button>
            <button type="button" className="keypad-key keypad-delete keypad-span-two" onClick={deleteLastKey} disabled={!expression}>
              <DeleteIcon aria-hidden="true" /> Delete
            </button>
            <button type="button" className="keypad-key keypad-clear keypad-span-two" onClick={clearEquation} disabled={!expression}>
              <Trash2 aria-hidden="true" /> Clear
            </button>
          </div>

          <div className="builder-actions">
            <Button variant="outline" onClick={clearEquation} className="builder-button">
              <Trash2 aria-hidden="true" /> Clear
            </Button>
            <StrategyDialog target={target} tens={tens} ones={ones} />
          </div>
        </section>

          <section className="history-panel" aria-labelledby="history-title">
          <div className="history-heading">
            <div>
              <h2 id="history-title">Math Equation History</h2>
              <p>Review the equations checked during this practice.</p>
            </div>
          </div>
          {history.length === 0 ? (
            <p className="history-empty">Checked equations will appear here.</p>
          ) : (
            <ol className="history-list">
              {history.map((entry) => (
                <li key={entry.id} className={entry.correct ? 'history-correct' : 'history-incorrect'}>
                  <span>{entry.equation}</span>
                  <strong>{entry.correct ? '✓ Correct' : '✕ Not Correct'}</strong>
                </li>
              ))}
            </ol>
          )}
            <dl className="history-stats" aria-label="Equation statistics">
              <div><dt>Total Questions</dt><dd>{history.length}</dd></div>
              <div><dt>Correct</dt><dd>{correctTotal}</dd></div>
              <div><dt>Incorrect</dt><dd>{incorrectTotal}</dd></div>
            </dl>
          </section>
        </section>
        <p className="practice-note">Practice tool only. Competition rules should determine the final target ranges and valid equation formats.</p>
      </main>

      <Dialog open={timesUpOpen} onOpenChange={setTimesUpOpen}>
        <DialogContent className="times-up-dialog" showCloseButton={false}>
          <div className="times-up-icon"><Timer aria-hidden="true" /></div>
          <DialogHeader className="times-up-copy">
            <DialogTitle className="dialog-title">Times Up!</DialogTitle>
            <DialogDescription>The three-minute timer has ended.</DialogDescription>
          </DialogHeader>
          <Button className="times-up-reset" onClick={() => setTimesUpOpen(false)}>Close</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChipPanel({ title, caption, tone, children }: { title: string; caption: string; tone: string; children: React.ReactNode }) {
  return (
    <section className={`chip-panel chip-panel-${tone}`}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <span>{caption}</span>
      </div>
      {children}
    </section>
  );
}

function ChipRow({ symbol, total, available, selected, color, onSelect, operator = false }: {
  symbol: SymbolKey;
  total: number;
  available: number;
  selected: number;
  color: string;
  onSelect: () => void;
  operator?: boolean;
}) {
  const used = total - available;
  return (
    <fieldset className={`chip-row ${operator ? 'operator-row' : ''}`} aria-label={`${symbol}: ${available} of ${total} chips available`}>
      {Array.from({ length: total }, (_, index) => {
        const unavailable = index >= total - used;
        const pending = !unavailable && index < selected;
        return (
          <button
            type="button"
            key={`${symbol}-${index}`}
            className={`chip chip-${color} ${operator ? 'operator-chip' : ''} ${unavailable ? 'chip-unavailable' : ''} ${pending ? 'chip-selected' : ''}`}
            onClick={onSelect}
            disabled={unavailable || selected >= available}
            aria-label={`${symbol} chip ${index + 1}, ${unavailable ? 'unavailable' : pending ? 'selected for this equation' : 'available'}`}
          >
            {symbol}
          </button>
        );
      })}
    </fieldset>
  );
}

function DiceCubeIcon() {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <path d="M18 3.5 31 10v16L18 32.5 5 26V10Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M5 10l13 6.5L31 10M18 16.5v16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="18" cy="9.5" r="1.5" fill="currentColor" />
      <circle cx="10.5" cy="15.5" r="1.4" fill="currentColor" />
      <circle cx="14.5" cy="24" r="1.4" fill="currentColor" />
      <circle cx="25" cy="16" r="1.4" fill="currentColor" />
      <circle cx="25" cy="25.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

function StrategyDialog({ target, tens, ones }: { target: number; tens: number; ones: number }) {
  const factorPair = findFactorPair(target);
  const nearHundred = target <= 100 ? `100 − ${100 - target}` : `100 + ${target - 100}`;
  const tensEquation = ones === 0 ? `${target} + 0` : `${tens} + ${ones}`;
  const strategies = [
    { number: 1, label: 'Tens + Ones', equation: tensEquation },
    { number: 2, label: 'Add 0', equation: `${target} + 0` },
    { number: 3, label: 'Minus 0', equation: `${target} − 0` },
    { number: 4, label: 'Add 1', equation: `${target - 1} + 1` },
    { number: 5, label: 'Minus 1', equation: `${target + 1} − 1` },
    { number: 6, label: 'Multiply by 1', equation: `${target} × 1` },
  ];

  function copyStrategy(equation: string) {
    void navigator.clipboard?.writeText(equation.replace(/\s/g, ''));
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" className="builder-button guide-button" />}>
        <Lightbulb aria-hidden="true" /> Quick Strategy Guide
      </DialogTrigger>
      <DialogContent className="strategy-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">Strategies for {target}</DialogTitle>
        </DialogHeader>
        <section className="strategy-section" aria-labelledby="basic-strategies">
          <h3 id="basic-strategies">Basic Strategies</h3>
          <div className="strategy-list">
            {strategies.map((strategy) => (
              <button type="button" key={strategy.label} onClick={() => copyStrategy(strategy.equation)}>
                <span>{strategy.number}. {strategy.label}</span><strong>{strategy.equation}</strong>
              </button>
            ))}
          </div>
        </section>
        <section className="strategy-section" aria-labelledby="advanced-strategies">
          <h3 id="advanced-strategies">Advanced Strategies</h3>
          <div className="strategy-list">
            <button type="button" onClick={() => copyStrategy(nearHundred)}>
              <span>1. Near 100</span><strong>{nearHundred}</strong>
            </button>
            {factorPair && (
              <button type="button" onClick={() => copyStrategy(`${factorPair[0]} × ${factorPair[1]}`)}>
                <span>2. Factors</span><strong>{factorPair[0]} × {factorPair[1]}</strong>
              </button>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
