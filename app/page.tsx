'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Dices,
  Lightbulb,
  RefreshCw,
  RotateCcw,
  Settings,
  Timer,
  Trash2,
  Undo2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

type SymbolKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '+' | '-' | '×' | '÷';
type Inventory = Record<SymbolKey, number>;
type Feedback = { kind: 'idle' | 'success' | 'error' | 'info'; message: string };
type Difficulty = 'lower' | 'upper';
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
  if (!/^\d+(?:[+\-×÷]\d+)+$/.test(expression)) {
    return { ok: false, reason: 'Use numbers with +, −, ×, or ÷ between them.' };
  }

  const numberTokens = expression.split(/[+\-×÷]/).map(Number);
  const operatorTokens = expression.match(/[+\-×÷]/g) ?? [];
  const numbers = [...numberTokens];
  const operators = [...operatorTokens];

  for (let index = 0; index < operators.length;) {
    const operator = operators[index];
    if (operator === '×' || operator === '÷') {
      if (operator === '÷' && numbers[index + 1] === 0) {
        return { ok: false, reason: 'Division by zero is not allowed.' };
      }
      const value = operator === '×'
        ? numbers[index] * numbers[index + 1]
        : numbers[index] / numbers[index + 1];
      numbers.splice(index, 2, value);
      operators.splice(index, 1);
    } else {
      index += 1;
    }
  }

  let value = numbers[0];
  operators.forEach((operator, index) => {
    value = operator === '+' ? value + numbers[index + 1] : value - numbers[index + 1];
  });

  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, reason: 'That equation cannot be calculated.' };
}

function formatTime(seconds: number) {
  return `0:${String(Math.max(0, seconds)).padStart(2, '0')}`;
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
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle', message: 'Tap chips or type an equation.' });
  const [difficulty, setDifficulty] = useState<Difficulty>('lower');
  const [timerSetting, setTimerSetting] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [showGuide, setShowGuide] = useState(true);
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

  useEffect(() => {
    const stored = window.localStorage.getItem('smart-delivery-settings');
    if (!stored) return;
    const restoreId = window.setTimeout(() => {
      try {
        const settings = JSON.parse(stored) as Partial<{
          difficulty: Difficulty;
          timerSetting: number;
          soundOn: boolean;
          showGuide: boolean;
        }>;
        if (settings.difficulty) setDifficulty(settings.difficulty);
        if ([0, 30, 60].includes(settings.timerSetting ?? -1)) {
          setTimerSetting(settings.timerSetting ?? 0);
          setTimeLeft(settings.timerSetting ?? 0);
        }
        if (typeof settings.soundOn === 'boolean') setSoundOn(settings.soundOn);
        if (typeof settings.showGuide === 'boolean') setShowGuide(settings.showGuide);
      } catch {
        window.localStorage.removeItem('smart-delivery-settings');
      }
    }, 0);
    return () => window.clearTimeout(restoreId);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('smart-delivery-settings', JSON.stringify({ difficulty, timerSetting, soundOn, showGuide }));
  }, [difficulty, timerSetting, soundOn, showGuide]);

  useEffect(() => {
    if (timerSetting === 0 || timeLeft <= 0) return;
    const timerId = window.setInterval(() => setTimeLeft((current) => current - 1), 1000);
    return () => window.clearInterval(timerId);
  }, [timerSetting, timeLeft]);

  function startNewNumber() {
    const next = randomTarget(difficulty, target);
    setTarget(next);
    setExpression('');
    setFeedback({ kind: 'idle', message: 'New number ready. Build an equation.' });
    setTimeLeft(timerSetting);
    return next;
  }

  function resetAll() {
    const next = randomTarget(difficulty, target);
    setInventory(makeInventory());
    setExpression('');
    setTarget(next);
    setFeedback({ kind: 'info', message: 'A fresh training round is ready.' });
    setTimeLeft(timerSetting);
    return next;
  }

  function resetAllChips() {
    setInventory(makeInventory());
    setFeedback({ kind: 'info', message: 'All number and operator chips are available again.' });
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

  function undoLastChip() {
    setExpression((current) => normalizeExpression(current).slice(0, -1));
    setFeedback({ kind: 'idle', message: 'Last chip removed.' });
  }

  function checkEquation(value = expression) {
    if (value !== expression) setExpression(value);
    if (timerSetting > 0 && timeLeft <= 0) {
      setFeedback({ kind: 'error', message: 'Time is up. Choose New Number to try another round.' });
      if (soundOn) playTone(false);
      return { status: 'time_up', target };
    }

    const result = evaluateExpression(value);
    if (!result.ok) {
      setFeedback({ kind: 'error', message: result.reason });
      if (soundOn) playTone(false);
      return { status: 'invalid', target, reason: result.reason };
    }

    if (Math.abs(result.value - target) > Number.EPSILON) {
      setFeedback({ kind: 'error', message: `${normalizeExpression(value)} = ${result.value}, not ${target}. Try another strategy.` });
      if (soundOn) playTone(false);
      return { status: 'incorrect', target, value: result.value };
    }

    const needed = requiredChips(value);
    const missing = Object.entries(needed).find(([symbol, count]) => inventory[symbol as SymbolKey] < (count ?? 0));
    if (missing) {
      setFeedback({ kind: 'error', message: `Correct maths, but there are not enough ${missing[0]} chips available.` });
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
    setFeedback({ kind: 'success', message: `Correct! ${normalizeExpression(value)} = ${target}. The required chips have been used.` });
    if (soundOn) playTone(true);
    return { status: 'correct', target, expression: normalizeExpression(value) };
  }

  function updateExpression(value: string) {
    const cleaned = value.replace(/[^0-9+\-×÷*/\s]/g, '').slice(0, 32);
    setExpression(cleaned);
    setFeedback({ kind: 'idle', message: 'Press Check when your equation is ready.' });
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
        description: 'Choose a new Math Answer, clear the equation, and restart the optional timer.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: () => ({ target: toolActionsRef.current.newNumber(), status: 'ready' }),
      },
      {
        name: 'reset_math_trainer',
        title: 'Reset maths trainer',
        description: 'Restore every chip and start a fresh training round.',
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
    <main className="trainer-shell">
      <section className="trainer-card" aria-labelledby="page-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">Practice workspace</p>
            <h1 id="page-title">Smart Delivery &amp; Maths Trainer</h1>
          </div>
          <div className="top-actions">
            <Button className="action-button action-primary" onClick={startNewNumber} size="lg">
              <Dices aria-hidden="true" /> New Number
            </Button>
            <Button className="action-button" variant="outline" onClick={resetAll} size="lg">
              <RotateCcw aria-hidden="true" /> Reset All
            </Button>
            <SettingsDialog
              difficulty={difficulty}
              setDifficulty={setDifficulty}
              timerSetting={timerSetting}
              setTimerSetting={(seconds) => { setTimerSetting(seconds); setTimeLeft(seconds); }}
              soundOn={soundOn}
              setSoundOn={setSoundOn}
              showGuide={showGuide}
              setShowGuide={setShowGuide}
            />
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
              {timerSetting > 0 && (
                <span className={`timer-pill ${timeLeft <= 5 ? 'timer-warning' : ''}`}>
                  <Timer aria-hidden="true" /> {formatTime(timeLeft)}
                </span>
              )}
            </div>
            <strong className="answer-number">{target}</strong>
          </div>
          <Button className="answer-new-button" variant="outline" onClick={startNewNumber} aria-label="Choose a new math answer">
            <Dices aria-hidden="true" />
            <span>New<br />Number</span>
          </Button>
        </section>

        <section className="equation-panel" aria-label="Equation builder">
          <div className="equation-row">
            <label className="sr-only" htmlFor="equation">Enter your equation</label>
            <input
              id="equation"
              className="equation-input"
              value={expression}
              onChange={(event) => updateExpression(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') checkEquation(); }}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Enter your equation here..."
            />
            <Button className="check-button" onClick={() => checkEquation()} size="lg">
              <Check aria-hidden="true" /> Check
            </Button>
          </div>

          <output className={`feedback feedback-${feedback.kind}`} aria-live="polite">{feedback.message}</output>

          <div className="builder-actions">
            <Button variant="outline" onClick={clearEquation} className="builder-button">
              <Trash2 aria-hidden="true" /> Clear
            </Button>
            <Button variant="outline" onClick={undoLastChip} className="builder-button" disabled={!expression}>
              <Undo2 aria-hidden="true" /> Undo Last Chip
            </Button>
            <Button variant="outline" onClick={resetAllChips} className="builder-button builder-reset">
              <RefreshCw aria-hidden="true" /> Reset All Chips
            </Button>
            {showGuide && <StrategyDialog target={target} tens={tens} ones={ones} />}
          </div>
        </section>
      </section>
      <p className="practice-note">Practice tool only. Competition rules should determine the final target ranges and valid equation formats.</p>
    </main>
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

function SettingsDialog({ difficulty, setDifficulty, timerSetting, setTimerSetting, soundOn, setSoundOn, showGuide, setShowGuide }: {
  difficulty: Difficulty;
  setDifficulty: (value: Difficulty) => void;
  timerSetting: number;
  setTimerSetting: (value: number) => void;
  soundOn: boolean;
  setSoundOn: (value: boolean) => void;
  showGuide: boolean;
  setShowGuide: (value: boolean) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button className="action-button" variant="outline" size="lg" />}>
        <Settings aria-hidden="true" /> Settings
      </DialogTrigger>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">Practice settings</DialogTitle>
          <DialogDescription>Adjust the challenge for this device.</DialogDescription>
        </DialogHeader>
        <div className="settings-list">
          <div className="setting-row">
            <span><strong>Difficulty</strong><small>Controls the target range</small></span>
            <Select value={difficulty} onValueChange={(value) => value && setDifficulty(value as Difficulty)}>
              <SelectTrigger className="setting-select" aria-label="Difficulty"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lower">Lower Primary</SelectItem>
                <SelectItem value="upper">Upper Primary</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="setting-row">
            <span><strong>Timer</strong><small>Optional reaction challenge</small></span>
            <Select value={String(timerSetting)} onValueChange={(value) => setTimerSetting(Number(value ?? 0))}>
              <SelectTrigger className="setting-select" aria-label="Timer"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Off</SelectItem>
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="60">60 seconds</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="setting-row">
            <span><strong>Sound</strong><small>Feedback after checking</small></span>
            <Switch checked={soundOn} onCheckedChange={setSoundOn} aria-label="Sound feedback" />
          </div>
          <div className="setting-row">
            <span><strong>Strategy guide</strong><small>Show the help button</small></span>
            <Switch checked={showGuide} onCheckedChange={setShowGuide} aria-label="Show strategy guide" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StrategyDialog({ target, tens, ones }: { target: number; tens: number; ones: number }) {
  const even = target % 2 === 0;
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" className="builder-button guide-button" />}>
        <Lightbulb aria-hidden="true" /> Quick Strategy Guide
      </DialogTrigger>
      <DialogContent className="strategy-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">Strategies for {target}</DialogTitle>
          <DialogDescription>Find a correct equation that also uses available chips.</DialogDescription>
        </DialogHeader>
        <div className="strategy-list">
          <button type="button" onClick={() => navigator.clipboard?.writeText(ones === 0 ? `${target}+0` : `${tens}+${ones}`)}>
            <span>Tens + Ones</span><strong>{ones === 0 ? `${target} + 0` : `${tens} + ${ones}`}</strong>
          </button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(`${target}+0`)}>
            <span>Add zero</span><strong>{target} + 0</strong>
          </button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(`${target}-0`)}>
            <span>Minus zero</span><strong>{target} − 0</strong>
          </button>
          {even && (
            <button type="button" onClick={() => navigator.clipboard?.writeText(`${target / 2}×2`)}>
              <span>Look for factors</span><strong>{target / 2} × 2</strong>
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
