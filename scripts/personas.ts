// Four delivery personas. The council's verdict is produced ONCE and shared;
// a persona only decides what a user sees and how it is framed.
//
// Filtering is deterministic on purpose: a rule is auditable, instant, free, and
// keeps the product an impersonal publication rather than tailored advice.
// Only the wording pass (framing) would use a model, and it runs once per
// verdict for all four personas, not once per user.

export type Verdict = {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  agreement: number;
  votes: number;
  meanConfidence: number;
  invest: boolean;
  panel?: number;
  debated?: boolean;
  regime?: 'BULL' | 'BEAR' | 'RANGE';
  changePct?: number | null;
};

export type Persona = {
  id: string;
  /** The user type this serves, from onboarding. */
  serves: string;
  name: string;
  /** What this user gets wrong, and what the persona does about it. */
  job: string;
  /** Deterministic: which verdicts this user sees at all. */
  show: (v: Verdict) => boolean;
  /** Aggregate-only views never name individual stocks. */
  aggregateOnly?: boolean;
  /** Lead with the counter-case rather than the recommendation. */
  riskFirst?: boolean;
  /** Instruction for the (shared) framing pass. */
  voice: string;
};

export const PERSONAS: Persona[] = [
  {
    id: 'brake',
    serves: 'Impulsive / High FOMO',
    name: 'The Brake',
    job: 'Slows the user down. Shows every verdict but leads with the counter-case, '
       + 'and flags when a stock has already run so they can see what they would be chasing.',
    // Sees everything: hiding verdicts from an impulsive user pushes them elsewhere.
    show: () => true,
    riskFirst: true,
    voice: 'Direct and cooling. Open with what could go wrong and what the stock has already done. '
         + 'Never use urgency. State plainly when the move has largely happened.',
  },
  {
    id: 'guardrail',
    serves: 'Cautious',
    name: 'The Guardrail',
    job: 'Surfaces only high-consensus buys in confirmed uptrends. Silence is the default.',
    show: (v) => v.action === 'BUY' && v.agreement >= 0.75 && v.votes >= 3 && v.regime === 'BULL',
    voice: 'Calm and factual. Lead with how much the council agreed and why. '
         + 'State the downside plainly without alarm. Short sentences.',
  },
  {
    id: 'simplifier',
    serves: 'Risk Averse Beginner',
    name: 'The Simplifier',
    job: 'Never names individual stocks. Reports only what the council did in aggregate, in plain language.',
    show: () => false,
    aggregateOnly: true,
    voice: 'Plain English, no jargon, no tickers. Explain what happened and what it means '
         + 'for someone who has never bought a share. Assume no prior knowledge.',
  },
  {
    id: 'mentor',
    serves: 'Analytical Learner',
    name: 'The Mentor',
    job: 'Shows everything: all four specialists, their evidence, the weights and the rubric arithmetic.',
    show: () => true,
    voice: 'Explanatory. Show the working: which specialist argued what, how each vote was weighted, '
         + 'and why the totals produced this verdict. Teach the method, not just the answer.',
  },
];

export const personaById = (id: string) => PERSONAS.find((p) => p.id === id) ?? PERSONAS[3];

/** Maps the 4-question onboarding quiz to a persona. Higher score = more risk-tolerant. */
export function routeFromQuiz(answers: number[]): Persona {
  const score = answers.reduce((a, b) => a + b, 0);   // each question 0-3
  if (answers[0] >= 3) return PERSONAS[0];            // "I'd buy more on a 20% drop" -> impulsive
  if (score <= 3) return PERSONAS[2];                 // very low tolerance -> simplifier
  if (score <= 7) return PERSONAS[1];                 // low-mid -> guardrail
  return PERSONAS[3];                                 // engaged / analytical -> mentor
}

// ---------- self-check ----------

if (import.meta.filename === process.argv[1]) {
  const { strict: assert } = await import('node:assert');
  const v = (o: Partial<Verdict>): Verdict => ({
    ticker: 'X', action: 'BUY', agreement: 0.8, votes: 3, meanConfidence: 7,
    invest: true, regime: 'BULL', ...o,
  });

  // Guardrail is strict: every condition must hold.
  assert.equal(PERSONAS[1].show(v({})), true);
  assert.equal(PERSONAS[1].show(v({ agreement: 0.7 })), false, 'below 75% agreement must be hidden');
  assert.equal(PERSONAS[1].show(v({ votes: 2 })), false, 'fewer than 3 votes must be hidden');
  assert.equal(PERSONAS[1].show(v({ regime: 'BEAR' })), false, 'bear trend must be hidden');
  assert.equal(PERSONAS[1].show(v({ action: 'HOLD' })), false, 'only buys are surfaced');

  // Brake and Mentor see everything; Simplifier names nothing.
  assert.equal(PERSONAS[0].show(v({ action: 'SELL', agreement: 0.3 })), true);
  assert.equal(PERSONAS[3].show(v({ action: 'HOLD', agreement: 0.1 })), true);
  assert.equal(PERSONAS[2].show(v({})), false);
  assert.equal(PERSONAS[2].aggregateOnly, true);

  // Routing
  assert.equal(routeFromQuiz([3, 2, 2, 2]).id, 'brake', 'buy-the-dip answer routes to Brake');
  assert.equal(routeFromQuiz([0, 0, 1, 1]).id, 'simplifier');
  assert.equal(routeFromQuiz([1, 2, 2, 1]).id, 'guardrail');
  assert.equal(routeFromQuiz([2, 3, 3, 3]).id, 'mentor');

  console.log('persona self-checks passed');
}
