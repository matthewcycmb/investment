// Snapshots the S&P 500 constituent list. Run ONCE at project start; the snapshot
// is frozen for the duration of the study (see PREREGISTRATION.md section 4).
import { get, writeJSON, ROOT, readJSON } from './lib.ts';

const SOURCE = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const OUT = `${ROOT}data/universe.json`;

/** Minimal RFC4180 row splitter — constituent names contain quoted commas. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const existing = readJSON<{ snapshotDate?: string }>(OUT, {});
if (existing.snapshotDate && !process.argv.includes('--force')) {
  console.error(`universe.json already snapshotted ${existing.snapshotDate}.`);
  console.error('The constituent list is frozen for the study. Use --force only if no picks exist yet.');
  process.exit(1);
}

const csv = await (await get(SOURCE)).text();
const [header, ...rows] = csv.trim().split('\n');
const cols = splitRow(header);
const idx = (name: string) => {
  const i = cols.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" missing; upstream CSV changed: ${cols.join('|')}`);
  return i;
};
const [iSym, iName, iSector, iCik] = [idx('Symbol'), idx('Security'), idx('GICS Sector'), idx('CIK')];

const constituents = rows.map((r) => {
  const f = splitRow(r);
  return {
    ticker: f[iSym].trim(),
    // Yahoo uses a dash where SEC/S&P use a dot (BRK.B -> BRK-B).
    yahoo: f[iSym].trim().replace(/\./g, '-'),
    name: f[iName].trim(),
    sector: f[iSector].trim(),
    cik: String(f[iCik]).trim().padStart(10, '0'),
  };
}).filter((c) => c.ticker && /^\d{10}$/.test(c.cik));

if (constituents.length < 400) throw new Error(`only ${constituents.length} constituents parsed; refusing to snapshot`);

writeJSON(OUT, {
  snapshotDate: new Date().toISOString().slice(0, 10),
  source: SOURCE,
  note: 'Frozen for the study. Constituents are NOT updated mid-study (PREREGISTRATION.md §4).',
  count: constituents.length,
  constituents,
});
console.log(`snapshotted ${constituents.length} constituents -> data/universe.json`);
