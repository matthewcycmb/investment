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
  /** Plain description of the rule. */
  job: string;
  /** Converts the shared council verdict into this user's verdict. */
  personalise: (v: Verdict) => 'BUY' | 'SELL' | 'HOLD';
};

export const PERSONAS: Persona[] = [
  {
    id: 'risktaker', serves: 'Risk Taker', name: 'Risk Taker',
    job: 'Gets the council verdict unchanged.',
    // Never softened. This user accepted volatility at signup.
    personalise: (v) => v.action,
  },
  {
    id: 'cautious', serves: 'Cautious', name: 'Cautious',
    job: 'A buy is only passed on when the council strongly agreed and the stock is already rising. '
       + 'Otherwise it becomes hold.',
    personalise: (v) =>
      v.action === 'BUY' && (v.agreement < 0.75 || v.votes < 3 || v.regime !== 'BULL') ? 'HOLD' : v.action,
  },
  {
    id: 'beginner', serves: 'Risk Averse Beginner', name: 'Beginner',
    job: 'Only near-unanimous buys are passed on. Everything else becomes hold, '
       + 'so a first-time investor is never handed a marginal call.',
    personalise: (v) =>
      v.action === 'BUY' && (v.agreement < 0.90 || v.votes < 4 || v.regime !== 'BULL') ? 'HOLD'
      : v.action === 'SELL' ? 'HOLD' : v.action,
  },
  {
    id: 'learner', serves: 'Analytical Learner', name: 'Learner',
    job: 'Gets the council verdict unchanged, with every specialist’s reasoning and the vote maths.',
    personalise: (v) => v.action,
  },
];

/**
 * A persona may only make a verdict MORE conservative, never less.
 * BUY can become HOLD; HOLD can never become BUY. The council is the ceiling on
 * risk, and no personal profile can raise it.
 */
export function personalVerdict(v: Verdict, p: Persona): 'BUY' | 'SELL' | 'HOLD' {
  const out = p.personalise(v);
  if (v.action !== 'BUY' && out === 'BUY') return v.action;   // never upgrade
  return out;
}

export const personaById = (id: string) => PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];

/** Maps the 4-question onboarding quiz to a persona. Each answer scores 0-3. */
export function routeFromQuiz(answers: number[]): Persona {
  const score = answers.reduce((a, b) => a + b, 0);
  if (score >= 9) return PERSONAS[0];   // high tolerance
  if (score <= 3) return PERSONAS[2];   // very low tolerance
  if (answers[3] >= 2) return PERSONAS[3]; // experienced -> wants the detail
  return PERSONAS[1];
}

// ---------- self-check ----------

if (import.meta.filename === process.argv[1]) {
  const { strict: assert } = await import('node:assert');
  const v = (o: Partial<Verdict>): Verdict => ({
    ticker: 'X', action: 'BUY', agreement: 0.95, votes: 4, meanConfidence: 8,
    invest: true, regime: 'BULL', ...o,
  });
  const [risk, caut, begin, learn] = PERSONAS;

  // A strong buy reaches everyone.
  for (const p of PERSONAS) assert.equal(personalVerdict(v({}), p), 'BUY', p.name);

  // A weak buy is softened for the cautious and the beginner, not the risk taker.
  const weak = v({ agreement: 0.65, votes: 2 });
  assert.equal(personalVerdict(weak, risk), 'BUY');
  assert.equal(personalVerdict(weak, learn), 'BUY');
  assert.equal(personalVerdict(weak, caut), 'HOLD');
  assert.equal(personalVerdict(weak, begin), 'HOLD');

  // A falling stock is not a buy for the cautious, however strong the vote.
  assert.equal(personalVerdict(v({ regime: 'BEAR' }), caut), 'HOLD');
  assert.equal(personalVerdict(v({ regime: 'BEAR' }), risk), 'BUY');

  // A persona can never make a verdict riskier than the council's.
  assert.equal(personalVerdict(v({ action: 'HOLD' }), risk), 'HOLD');
  assert.equal(personalVerdict(v({ action: 'SELL' }), risk), 'SELL');
  assert.equal(personalVerdict(v({ action: 'SELL' }), begin), 'HOLD', 'beginner is never told to sell');

  assert.equal(routeFromQuiz([3, 3, 3, 3]).id, 'risktaker');
  assert.equal(routeFromQuiz([0, 1, 1, 1]).id, 'beginner');

  console.log('persona self-checks passed');
}
