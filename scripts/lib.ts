// Shared helpers: polite HTTP, price bars, JSON io, and the statistics the
// primary test depends on. Run `node scripts/lib.ts` to execute the self-checks.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sorted .json filenames in a directory; empty if the directory does not exist yet. */
export const lsJSON = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

export const SEC_UA = 'AI-Council-Research jchanh@gmail.com';
export const ROOT = new URL('..', import.meta.url).pathname;

// ---------- http ----------

const lastCall = new Map<string, number>();

/** Rate-limited, retrying fetch. `key` groups callers sharing a budget. */
export async function get(
  url: string,
  { key = 'default', minGapMs = 150, headers = {}, tries = 3 } = {},
): Promise<Response> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const wait = (lastCall.get(key) ?? 0) + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall.set(key, Date.now());
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return res;
      // 4xx other than 429 will not fix themselves; fail fast.
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
      }
    } catch (err) {
      if (attempt === tries - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error(`exhausted retries for ${url}`);
}

export const secJSON = async (url: string) =>
  (await get(url, { key: 'sec', minGapMs: 110, headers: { 'User-Agent': SEC_UA } })).json();

export const secText = async (url: string) =>
  (await get(url, { key: 'sec', minGapMs: 110, headers: { 'User-Agent': SEC_UA } })).text();

// ---------- prices ----------

export type Bar = { date: string; open: number; close: number };

/**
 * Daily bars from Yahoo's chart endpoint. Sessions with a null open are dropped,
 * so the returned array doubles as the trading calendar — no holiday table needed.
 */
export async function bars(symbol: string, range = '1y'): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await get(url, { key: 'yahoo', minGapMs: 220, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const result = (await res.json())?.chart?.result?.[0];
  if (!result?.timestamp) throw new Error(`no bars for ${symbol}`);
  const q = result.indicators.quote[0];
  return result.timestamp
    .map((t: number, i: number) => ({
      // US sessions open 13:30/14:30 UTC, so the UTC date equals the ET session date.
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open[i],
      close: q.close[i],
    }))
    .filter((b: Bar) => b.open != null && b.close != null);
}

// ---------- json io ----------

export function readJSON<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

export function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// ---------- statistics ----------
// The primary test rests on these, so they are implemented properly rather than
// approximated with a normal distribution.

function lgamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction expansion for the incomplete beta function. */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300, EPS = 3e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Upper-tail p-value P(T > t) for Student's t with `df` degrees of freedom. */
export function tSF(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return NaN;
  const p = 0.5 * betai(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? p : 1 - p;
}

export type TestResult = { n: number; mean: number; t: number; df: number; p: number };

/** One-sided one-sample t-test, H0: mean <= 0. Treats every observation as independent. */
export function tTestNaive(xs: number[]): TestResult {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, t: NaN, df: n - 1, p: NaN };
  const varS = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const t = mean / Math.sqrt(varS / n);
  return { n, mean, t, df: n - 1, p: tSF(t, n - 1) };
}

/**
 * Same test with CR1 cluster-robust standard errors. Overlapping holding windows
 * make picks entered in the same week correlated; clustering on entry week is the
 * pre-registered primary specification.
 */
export function tTestClustered(xs: number[], clusters: string[]): TestResult {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const byCluster = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    byCluster.set(clusters[i], (byCluster.get(clusters[i]) ?? 0) + (xs[i] - mean));
  }
  const G = byCluster.size;
  if (G < 2) return { n, mean, t: NaN, df: G - 1, p: NaN };
  let meat = 0;
  for (const s of byCluster.values()) meat += s * s;
  const correction = G / (G - 1); // CR1 with k=1 parameter
  const varMean = (correction * meat) / (n * n);
  const t = mean / Math.sqrt(varMean);
  return { n, mean, t, df: G - 1, p: tSF(t, G - 1) };
}

/** ISO week key, used as the clustering variable. */
export function weekKey(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this ISO week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / 604_800_000);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------- self-checks ----------

if (import.meta.filename === process.argv[1]) {
  const { strict: assert } = await import('node:assert');
  const near = (a: number, b: number, tol = 1e-3) =>
    assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

  // t distribution against published critical values
  near(tSF(1.812, 10), 0.05, 1e-3);   // t(10) 95th percentile
  near(tSF(1.984, 99), 0.025, 1e-3);  // t(99) 97.5th percentile
  near(tSF(0, 5), 0.5, 1e-9);
  near(tSF(-1.812, 10), 0.95, 1e-3);

  // naive t-test against a hand-computed example
  const naive = tTestNaive([1, 2, 3, 4, 5]);
  near(naive.mean, 3);
  near(naive.t, 3 / (Math.sqrt(2.5) / Math.sqrt(5)));
  assert.equal(naive.df, 4);

  // clustering must widen the interval when clusters are internally correlated
  const xs = [0.05, 0.05, 0.05, -0.04, -0.04, -0.04];
  const cl = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2'];
  assert.ok(tTestClustered(xs, cl).p > tTestNaive(xs).p,
    'clustered p-value must exceed naive when within-cluster correlation is perfect');
  assert.equal(tTestClustered(xs, cl).df, 1);

  // excess-return arithmetic: the exact quantity the primary test consumes
  const pickRet = 110 / 100 - 1;
  const spyRet = 102 / 100 - 1;
  near(pickRet - spyRet, 0.08);

  // ISO week keys, including the year-boundary case that off-by-one bugs love
  assert.equal(weekKey('2026-07-27'), '2026-W31');
  assert.equal(weekKey('2026-01-01'), '2026-W01');
  assert.equal(weekKey('2027-01-03'), '2026-W53'); // Sunday belongs to the prior ISO week

  console.log('lib self-checks passed');
}
