#!/usr/bin/env node
/**
 * Quarterly (10-Q) XBRL ingestion — sibling of ingest-edgar.mjs.
 *
 * Fetches SEC companyfacts for the sector-labeled index universe (S&P 500 +
 * S&P 400 by default; ~900 names) and stores QUARTERLY facts (fp=FQ, form
 * 10-Q/10-Q/A) for the last ~12 quarters, plus rolling-TTM metrics.
 *
 * Storage decision (documented in README-DATA.md):
 *   - facts_quarterly table, NOT a period column on `facts`. svc-edgar's
 *     screener revenue CTE reads `facts` unfiltered and relies on a 300-400
 *     day gap between the two latest period ends for YoY growth — quarterly
 *     rows in `facts` would poison that. Keeping the tables separate leaves
 *     every existing consumer untouched.
 *   - TTM metrics are computed AT INGEST TIME into metrics_ttm (not at query
 *     time): per company, the 4 most recent consecutive fiscal quarters
 *     (gaps 80-100 days) are summed for revenue_ttm / net_income_ttm, the
 *     prior 4 quarters for revenue_ttm_prior, giving revenue_growth_ttm and
 *     net_margin_ttm. Deterministic, queryable, no windowing SQL needed.
 *
 * Usage:
 *   node scripts/ingest-edgar-quarterly.mjs             # S&P 500 + S&P 400 (~900)
 *   node scripts/ingest-edgar-quarterly.mjs --sp500     # S&P 500 only
 *   node scripts/ingest-edgar-quarterly.mjs --sp400     # S&P 400 only
 *
 * SEC policy: descriptive User-Agent, ~5 req/s with retry/backoff (shared
 * throttle from ingest-edgar.mjs).
 *
 * DuckDB single-writer: stop the edgar container before running this
 * (docker compose stop tradexa-edgar), restart after.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UA, DATA_DIR, DB_PATH, fetchJson, fetchText,
  getSp500Universe, getSp400Universe,
  REVENUE_TAGS, NET_INCOME_TAGS,
} from './ingest-edgar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ERROR_LOG = path.join(DATA_DIR, 'ingest-quarterly-errors.log');

const COMPANYFACTS_URL = (cik) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;

// ~12 quarters of history: cutoff 40 months back from today.
const CUTOFF_MS = Date.now() - 40 * 30.44 * 24 * 3600 * 1000;

// ---- quarterly fact extraction ----
function isQuarterly(v) {
  // companyfacts encodes fiscal focus as Q1..Q4 ('FQ' is frames-API naming)
  if (!/^Q[1-4]$/.test(v.fp || '')) return false;
  if (!/^10-Q/.test(v.form || '')) return false;
  if (!v.start) return false; // need a duration to confirm a true quarter
  const days = (new Date(v.end) - new Date(v.start)) / 86400000;
  if (days < 55 || days > 130) return false; // exclude YTD (180/270d) stubs
  return new Date(v.end).getTime() >= CUTOFF_MS;
}

function collectQuarterly(facts, taxonomy, tags) {
  const taxonomyFacts = facts?.[taxonomy];
  if (!taxonomyFacts) return [];
  const out = [];
  for (const tag of tags) {
    const entry = taxonomyFacts[tag];
    const units = entry?.units?.USD || entry?.units?.['USD/shares'];
    if (!units) continue;
    for (const v of units) {
      if (!isQuarterly(v)) continue;
      out.push({
        tag,
        val: v.val,
        end: new Date(v.end),
        // `filed` = when this value became public (look-ahead-free consumers).
        filed: v.filed ? new Date(v.filed) : null,
        fy: String(v.fy ?? ''),
        fp: v.fp,
        form: v.form,
        frame: v.frame ?? null,
      });
    }
  }
  return out;
}

const QUARTERLY_TAG_FAMILIES = [REVENUE_TAGS, NET_INCOME_TAGS];

function extractQuarterlyFacts(companyFacts) {
  const rows = QUARTERLY_TAG_FAMILIES.flatMap((tags) =>
    collectQuarterly(companyFacts, 'us-gaap', tags)
  );
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.tag}|${r.end.toISOString()}|${r.val}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every revenue / net-income fact in the window regardless of duration —
// computeTtm needs the quarterly, YTD and annual shapes to derive Q4.
function collectTtmInputs(companyFacts) {
  const rows = [];
  for (const tags of QUARTERLY_TAG_FAMILIES) {
    for (const tag of tags) {
      const entry = companyFacts?.['us-gaap']?.[tag];
      const units = entry?.units?.USD;
      if (!units) continue;
      for (const v of units) {
        const end = new Date(v.end);
        if (end.getTime() < CUTOFF_MS) continue;
        rows.push({
          tag, val: v.val, end,
          start: v.start ? new Date(v.start) : null,
          filed: v.filed ? new Date(v.filed) : null,
          fy: String(v.fy ?? ''), fp: v.fp, form: v.form,
        });
      }
    }
  }
  return rows;
}

// ---- rolling-TTM computation (at ingest time) ----
//
// Standalone Q4 values never appear in 10-Qs (Q4 = full year − 9-month YTD,
// both filed in the 10-K), so the period series is built as:
//   Q1/Q2/Q3 -> 55-130d duration facts from 10-Qs
//   Q4       -> annual (10-K, >=300d) minus same-end YTD (10-Q, 150-400d)
// The derived Q4 carries filed_at = max(10-K filed, YTD filed), keeping the
// series look-ahead-free.

function durationDays(v) {
  return v.start ? (new Date(v.end) - new Date(v.start)) / 86400000 : null;
}

// Latest-filed raw fact per period end within one tag.
function latestFiledByEnd(rows, tag, classify) {
  const m = new Map();
  for (const r of rows) {
    if (r.tag !== tag) continue;
    if (classify && !classify(r)) continue;
    const k = r.end.getTime();
    const prev = m.get(k);
    if (!prev || (r.filed && (!prev.filed || r.filed > prev.filed))) {
      m.set(k, r);
    }
  }
  return m;
}

function isQuarterlyFact(r) {
  return /^Q[1-4]$/.test(r.fp || '') && /^10-Q/.test(r.form || '') &&
    r.start && durationDays(r) >= 55 && durationDays(r) <= 130 &&
    r.end.getTime() >= CUTOFF_MS;
}
function isAnnualFact(r) {
  return r.fp === 'FY' && /^10-K/.test(r.form || '') &&
    r.start && durationDays(r) >= 300 && r.end.getTime() >= CUTOFF_MS;
}
function isYtdFact(r) {
  return /^Q[1-4]$/.test(r.fp || '') && /^10-Q/.test(r.form || '') &&
    r.start && durationDays(r) >= 150 && durationDays(r) <= 400 &&
    r.end.getTime() >= CUTOFF_MS;
}

// Per quarter end, { val, filed } — quarterly direct + Q4 derived (FY − YTD);
// then the first tag in priority order that has a value wins.
function pickPerEnd(rows, tagsPriority) {
  const perEnd = new Map();
  for (const tag of tagsPriority) {
    const q = latestFiledByEnd(rows, tag, isQuarterlyFact);
    const ytd = latestFiledByEnd(rows, tag, isYtdFact);
    const ann = latestFiledByEnd(rows, tag, isAnnualFact);
    const byEnd = new Map();
    for (const [k, r] of q) {
      byEnd.set(k, { val: r.val, filed: r.filed });
    }
    for (const [k, a] of ann) {
      // Q4 standalone = FY − 9M-YTD: pair the FY end with the YTD end ~1
      // quarter earlier in the same fiscal year (they are different dates).
      let y = null;
      for (const [yk, yr] of ytd) {
        const gap = (k - yk) / 86400000;
        if (gap > 0 && gap < 130 && (!y || yr.filed > y.filed)) y = yr;
      }
      if (!y || byEnd.has(k)) continue;
      byEnd.set(k, { val: a.val - y.val, filed: a.filed && y.filed ? (a.filed > y.filed ? a.filed : y.filed) : (a.filed || y.filed) });
    }
    for (const [k, rec] of byEnd) {
      if (!perEnd.has(k)) perEnd.set(k, rec);
    }
  }
  return perEnd;
}

// Sum 4 consecutive quarters ending at ends[i..i+3] (desc order); gaps must
// look like fiscal quarters (80-100 days) or the window is not a clean TTM.
function ttmWindow(endsDesc, perEnd, startIdx) {
  if (startIdx + 4 > endsDesc.length) return null;
  let sum = 0;
  let maxFiled = null;
  for (let j = startIdx; j < startIdx + 4; j++) {
    const rec = perEnd.get(endsDesc[j]);
    if (!rec) return null;
    if (j > startIdx) {
      const gap = (endsDesc[j - 1] - endsDesc[j]) / 86400000;
      if (gap < 80 || gap > 100) return null;
    }
    sum += rec.val;
    if (rec.filed && (!maxFiled || rec.filed > maxFiled)) maxFiled = rec.filed;
  }
  return { sum, maxFiled };
}

function computeTtm(ttmRows) {
  const rev = pickPerEnd(ttmRows, REVENUE_TAGS);
  const ni = pickPerEnd(ttmRows, NET_INCOME_TAGS);
  // TTM window anchored on revenue quarter ends (net income follows the same
  // fiscal calendar for the overwhelming majority of filers; quarters where a
  // net-income value is missing void the window rather than mis-summing).
  const endsDesc = [...rev.keys()].sort((a, b) => b - a);
  if (endsDesc.length < 4) return null;

  const cur = ttmWindow(endsDesc, rev, 0);
  if (!cur) return null;
  const niCur = ttmWindow(endsDesc, ni, 0);
  const prior = ttmWindow(endsDesc, rev, 4);
  const niPrior = ttmWindow(endsDesc, ni, 4);

  const revenue_growth_ttm =
    prior && prior.sum > 0 ? cur.sum / prior.sum - 1 : null;
  const net_margin_ttm = niCur && cur.sum !== 0 ? niCur.sum / cur.sum : null;

  return {
    quarter_end: new Date(endsDesc[0]),
    revenue_ttm: cur.sum,
    revenue_ttm_prior: prior?.sum ?? null,
    revenue_growth_ttm,
    net_income_ttm: niCur?.sum ?? null,
    net_margin_ttm,
    filed_at: cur.maxFiled,
    n_quarters: endsDesc.length,
  };
}

// ---- DuckDB ----
async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();
  await conn.run(`
    CREATE TABLE IF NOT EXISTS facts_quarterly (
      cik BIGINT,
      tag VARCHAR,
      "end" DATE,
      val DOUBLE,
      fy VARCHAR,
      fp VARCHAR,
      form VARCHAR,
      frame VARCHAR,
      filed_at DATE
    );
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS metrics_ttm (
      cik BIGINT PRIMARY KEY,
      quarter_end DATE,
      revenue_ttm DOUBLE,
      revenue_ttm_prior DOUBLE,
      revenue_growth_ttm DOUBLE,
      net_income_ttm DOUBLE,
      net_margin_ttm DOUBLE,
      filed_at DATE,
      n_quarters INTEGER
    );
  `);
  return { instance, conn };
}

async function main() {
  const args = process.argv.slice(2);
  const sp500Only = args.includes('--sp500');
  const sp400Only = args.includes('--sp400');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(
    `Fetching universe (quarterly: ${sp500Only ? 'S&P 500' : sp400Only ? 'S&P 400' : 'S&P 500 + S&P 400'})...`
  );
  const parts = [];
  if (!sp400Only) parts.push(await getSp500Universe());
  if (!sp500Only) parts.push(await getSp400Universe());
  // merge on CIK (indexes are disjoint in practice; dedupe defensively)
  const byCik = new Map();
  for (const c of parts.flat()) if (!byCik.has(c.cik)) byCik.set(c.cik, c);
  const universe = [...byCik.values()];
  console.log(`Universe size: ${universe.length}`);

  const { instance, conn } = await initDb();
  const logErr = (ticker, cik, msg) => {
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()}\t${ticker}\t${cik}\t${msg}\n`);
  };

  const insertCompany = (c) =>
    conn.run('INSERT OR REPLACE INTO companies VALUES (?, ?, ?, ?, ?)', [
      BigInt(c.cik), c.ticker, c.name, c.sic, c.sector,
    ]);
  const insertFactRow = (cik, f) =>
    conn.run(
      'INSERT INTO facts_quarterly VALUES (?, ?, CAST(? AS DATE), ?, ?, ?, ?, ?, CAST(? AS DATE))',
      [BigInt(cik), f.tag, f.end.toISOString().slice(0, 10), f.val, f.fy, f.fp, f.form, f.frame,
       f.filed ? f.filed.toISOString().slice(0, 10) : null]
    );

  let ok = 0, failed = 0, noFacts = 0, ttmOk = 0;
  const t0 = Date.now();

  for (let i = 0; i < universe.length; i++) {
    const c = universe[i];
    try {
      const facts = await fetchJson(COMPANYFACTS_URL(c.cik));
      const companyFacts = facts.facts || {};
      const qRows = extractQuarterlyFacts(companyFacts);
      await insertCompany(c);

      await conn.run('DELETE FROM facts_quarterly WHERE cik = ?', [BigInt(c.cik)]);
      for (const f of qRows) await insertFactRow(c.cik, f);

      if (!qRows.some((r) => REVENUE_TAGS.includes(r.tag))) {
        noFacts++;
        logErr(c.ticker, c.cik, 'no quarterly 10-Q facts in window');
      } else {
        const ttm = computeTtm(collectTtmInputs(companyFacts));
        if (ttm) {
          await conn.run(
            `INSERT OR REPLACE INTO metrics_ttm VALUES (?, CAST(? AS DATE), ?, ?, ?, ?, ?, CAST(? AS DATE), ?)`,
            [BigInt(c.cik), ttm.quarter_end.toISOString().slice(0, 10),
             ttm.revenue_ttm, ttm.revenue_ttm_prior, ttm.revenue_growth_ttm,
             ttm.net_income_ttm, ttm.net_margin_ttm,
             ttm.filed_at ? ttm.filed_at.toISOString().slice(0, 10) : null,
             ttm.n_quarters]
          );
          ttmOk++;
        }
      }
      ok++;
    } catch (err) {
      failed++;
      logErr(c.ticker, c.cik, err.message);
    }

    if ((i + 1) % 25 === 0 || i === universe.length - 1) {
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(
        `[${i + 1}/${universe.length}] ok=${ok} ttm=${ttmOk} noFacts=${noFacts} failed=${failed} (${rate} co/s)`
      );
    }
  }

  conn.closeSync();
  await instance.closeSync?.();
  console.log(`Done. ingested=${ok} ttm=${ttmOk} noFacts=${noFacts} failed=${failed} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`Errors logged to ${ERROR_LOG}`);
  process.exit(0);
}

// ---- testable exports ----
export { COMPANYFACTS_URL, CUTOFF_MS, isQuarterly, collectQuarterly, extractQuarterlyFacts, collectTtmInputs, computeTtm };

const isMain =
  process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
