#!/usr/bin/env node
/**
 * svc-verdict (port 8003) — verdict orchestration per ADR-001.
 * Stateless compute plane: calls svc-market-data (quote + 1y candles), svc-news
 * (drivers), svc-edgar (company fundamentals), svc-llm (narrative when key
 * present). Scoring is the EXACT quant logic from src/services/quantEngine.ts;
 * levels mirror src/services/levelsService.ts; response shape is the AiVerdict
 * from src/types/verdict.ts so the existing UI keeps working.
 */
import { startService, loadEnvLocal, traceCtx, httpClient, logger } from '../shared/lib.mjs';
import { scoreVerdict, percentileRank } from './quantEngine.mjs';
import { computeLevels, getStopLossAndTargets } from './levels.mjs';
import { initDailyReport, runDailyReport, getDailyReport, scheduleDailyReport, catchUpDailyReport } from './dailyReport.mjs';
import fs from 'node:fs';
import path from 'node:path';

loadEnvLocal();

/**
 * Bump when scoring math, prompt, or narrative semantics change — the research
 * cache keys on this, so bumping invalidates every cached analysis at once.
 */
const VERDICT_ENGINE_VERSION = '2026-10-27.5'; // first-passage ETA (mu/sigma log-return drift model) replaces ATR-division ETA
const RESEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // narrative/ensemble live 24h
const RESEARCH_CACHE_DIR = path.join(process.env.DATA_DIR || '/app/data', 'verdict-cache');

/**
 * Research-layer cache (the expensive part: LLM ensemble narrative + vote).
 * Quant score/levels/targets are NEVER cached — they recompute live so buy/sell
 * zones stay market-accurate on every request.
 *
 * Files: data/verdict-cache/{SYMBOL}.json — one per symbol, human-readable.
 * Invalidation: engine-version mismatch, 24h age, ?refresh=1, or an earnings
 * report occurring after the cache was written (analysis made pre-earnings is
 * a different animal — never serve it across the print).
 */
function researchCachePath(symbol) {
  return path.join(RESEARCH_CACHE_DIR, `${symbol}.json`);
}

function readResearchCache(symbol, currentEarningsDate) {
  try {
    const raw = JSON.parse(fs.readFileSync(researchCachePath(symbol), 'utf8'));
    if (raw.engineVersion !== VERDICT_ENGINE_VERSION) return null;
    if (Date.now() - raw.cachedAt > RESEARCH_CACHE_TTL_MS) return null;
    if (currentEarningsDate && raw.earningsDate !== currentEarningsDate) return null; // crossed an earnings print
    return raw.research || null;
  } catch {
    return null;
  }
}

function writeResearchCache(symbol, currentEarningsDate, research) {
  try {
    fs.mkdirSync(RESEARCH_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      researchCachePath(symbol),
      JSON.stringify({ symbol, engineVersion: VERDICT_ENGINE_VERSION, cachedAt: Date.now(), earningsDate: currentEarningsDate || null, research }, null, 2)
    );
  } catch (err) {
    appLog?.warn?.({ msg: `research cache write failed for ${symbol}: ${err.message}` });
  }
}

const DISCLAIMER =
  'This verdict is AI-generated research for informational purposes only. It is not financial advice and should not be relied upon to make investment decisions. Always do your own research and consult a licensed financial adviser before trading.';

// ---- Peer resolution: registry first, static SERVICES_JSON fallback ------
const STATIC_SERVICES = {
  'market-data': 'http://localhost:8001',
  edgar: 'http://localhost:8002',
  verdict: 'http://localhost:8003',
  news: 'http://localhost:8004',
  llm: 'http://localhost:8005',
};
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8010';

const resolveCache = new Map(); // name -> {url, until}

async function resolveService(name, ctx) {
  const cached = resolveCache.get(name);
  if (cached && Date.now() < cached.until) return cached.url;

  try {
    const res = await httpClient.fetch(`${REGISTRY_URL}/resolve/${name}`, { ctx, span: `verdict.resolve.${name}`, timeoutMs: 2000, log: appLog });
    if (res.ok && res.json?.url) {
      resolveCache.set(name, { url: res.json.url, until: Date.now() + 10_000 });
      return res.json.url;
    }
  } catch { /* fall through to static */ }

  const fallback = process.env.SERVICES_JSON ? JSON.parse(process.env.SERVICES_JSON)[name] : STATIC_SERVICES[name];
  if (fallback) {
    resolveCache.set(name, { url: fallback, until: Date.now() + 10_000 });
    return fallback;
  }
  throw new Error(`no route to service '${name}' (registry + static fallback failed)`);
}

let appLog;
async function callPeer(name, path, { ctx, method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const base = await resolveService(name, ctx);
  const res = await httpClient.fetch(`${base}${path}`, { ctx, span: `verdict.${name}`, method, body, timeoutMs, log: appLog });
  if (!res.ok && res.status !== 404) throw new Error(`${name}${path} -> ${res.status}`);
  return res.json;
}

// ---- Orchestrator (port of aiVerdictService.generateVerdict) --------------
// opts.depth: 'full' (default) = news + cached LLM narrative + ensemble.
//             'quant'          = deterministic score/levels ONLY — no news, no
//                                LLM, zero tokens. Used by the watchlist alert
//                                checker and any high-frequency consumer.
// opts.refresh: bypass the research cache and regenerate the narrative.
async function generateVerdict(symbol, ctx, opts = {}) {
  const depth = opts.depth === 'quant' ? 'quant' : 'full';
  const clean = String(symbol).trim().toUpperCase();
  if (!clean) throw Object.assign(new Error('Symbol is required'), { statusCode: 400 });

  // ---- Gather inputs; each fetch degrades independently -------------------
  // quant depth skips news (only feeds the ±25 sentiment term → 0) but keeps
  // EDGAR fundamentals (cheap local read, feeds the ±35 quality term).
  const [quoteRes, candlesRes, newsRes, edgarRes, earningsRes] = await Promise.allSettled([
    callPeer('market-data', `/quote/${encodeURIComponent(clean)}`, { ctx }),
    callPeer('market-data', `/candles/${encodeURIComponent(clean)}?timeframe=1y&interval=1d`, { ctx }),
    depth === 'quant' ? Promise.resolve(null) : callPeer('news', `/drivers/${encodeURIComponent(clean)}`, { ctx }),
    callPeer('edgar', `/company/${encodeURIComponent(clean)}`, { ctx }),
    // Earnings-calendar awareness: surfaced as a badge + caution in the UI.
    callPeer('research', `/earnings/${encodeURIComponent(clean)}`, { ctx, timeoutMs: 20_000 }),
  ]);

  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const candles = candlesRes.status === 'fulfilled' ? candlesRes.value?.candles ?? [] : [];
  const news = newsRes.status === 'fulfilled' && newsRes.value
    ? { newsItems: newsRes.value.newsItems ?? [], bullish: newsRes.value.bullish ?? [], bearish: newsRes.value.bearish ?? [], sentimentScore: newsRes.value.sentimentScore ?? 0 }
    : { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 };
  const edgarFundamentals = edgarRes.status === 'fulfilled' ? edgarRes.value?.fundamentals ?? null : null;
  const earnings = earningsRes.status === 'fulfilled' && earningsRes.value?.earningsDate
    ? { earningsDate: earningsRes.value.earningsDate, daysUntil: earningsRes.value.daysUntil }
    : null;
  for (const r of [quoteRes, candlesRes, newsRes, edgarRes, earningsRes]) {
    if (r.status === 'rejected') appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `verdict input degraded: ${r.reason?.message}` });
  }

  const price = quote?.price || candles[candles.length - 1]?.close || 0;
  if (!price) throw Object.assign(new Error(`Unable to determine price for ${clean}`), { statusCode: 502 });
  const name = quote?.name || clean;

  // ---- Technicals ---------------------------------------------------------
  let sma20, sma50, sma200;
  let levels = null;
  try {
    levels = computeLevels(candles);
    sma20 = levels.sma20;
    sma50 = levels.sma50;
    sma200 = levels.sma200;
  } catch (err) {
    appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `levels failed for ${clean}: ${err.message}` });
  }

  // ---- Quantitative score via the shared quant core -----------------------
  const fundSrc = edgarFundamentals
    ? {
        revenueGrowthYoY: edgarFundamentals.revenueGrowthYoY,
        netMargin: edgarFundamentals.netMargin,
        roe: edgarFundamentals.roe,
        peRatio: edgarFundamentals.peRatio,
      }
    : undefined;

  // ---- Sector-relative fundamentals (P1-2 audit fix) -----------------------
  // When EDGAR reports a real sector, rank the company's fundamentals as
  // percentiles WITHIN its sector (svc-edgar /sector-stats — server-cached
  // 24h) instead of scoring against absolute thresholds. Any failure here
  // (unknown sector, warehouse unavailable, timeout) degrades gracefully to
  // the absolute thresholds — the sectorPercentiles input simply stays absent.
  const sector = edgarFundamentals?.sector || null;
  let sectorPercentiles;
  if (sector && sector !== 'Unknown') {
    try {
      const stats = await callPeer('edgar', `/sector-stats?sector=${encodeURIComponent(sector)}&distribution=1`, { ctx, timeoutMs: 8000 });
      const dist = stats?.distributions;
      const company = { growth: edgarFundamentals?.revenueGrowthYoY, margin: edgarFundamentals?.netMargin, roe: edgarFundamentals?.roe, pe: edgarFundamentals?.peRatio };
      const pcts = {};
      for (const [k, v] of Object.entries(company)) {
        const r = percentileRank(dist?.[k], v);
        if (r !== undefined) pcts[k] = r;
      }
      if (Object.keys(pcts).length) sectorPercentiles = { ...pcts, sector };
    } catch (err) {
      appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `sector stats unavailable for ${clean} (${sector}): ${err.message}` });
    }
  }

  const quant = scoreVerdict({ price, candles, sentimentScore: news.sentimentScore, fundamentals: fundSrc, sectorPercentiles });
  const { score, confidence, calibrated: confidenceCalibrated } = quant;
  let action = quant.action;
  const trend = quant.trend;
  const rsi14 = levels?.rsi14 ?? quant.rsi14;

  let fundamentals;
  if (edgarFundamentals) {
    fundamentals = {
      revenueGrowthYoY: edgarFundamentals.revenueGrowthYoY,
      netMargin: edgarFundamentals.netMargin,
      roe: edgarFundamentals.roe,
      peRatio: edgarFundamentals.peRatio,
      source: edgarFundamentals.source,
      // Sector-relative scoring receipts (P1-2): which sector the factors were
      // ranked against and the percentile basis actually used.
      sector,
      ...(sectorPercentiles ? { sectorPercentiles } : {}),
    };
  } else {
    // Yahoo-quote fallback fundamentals (price-derived), mirrors fromYahooFinancials minimally.
    fundamentals = { source: 'Yahoo Finance' };
    if (quote?.peRatio !== undefined && quote?.peRatio !== null) fundamentals.peRatio = quote.peRatio;
  }

  // Horizon: swing when strong trend + RSI extreme, else long
  const rsiExtreme = rsi14 !== undefined && (rsi14 < 30 || rsi14 > 70);
  const trendStrong = trend !== 'sideways';
  const horizon = trendStrong && rsiExtreme ? 'swing' : trendStrong ? 'swing' : 'long';

  // ---- Trade window: how long this analysis is meant to be acted on --------
  // Explicit holding period per trade (user ask): swing = ~1 week (5 trading
  // days), long = ~1 month (21). The window always ends at the next earnings
  // report when one falls inside it — an analysis is not meant to survive
  // through an earnings print.
  const holdingDays = horizon === 'swing' ? 5 : 21;
  const WEEKDAYS = (n) => {
    // n trading days from now (skips Sat/Sun), as ISO date
    const d = new Date(Date.now());
    let added = 0;
    while (added < n) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) added++;
    }
    return d;
  };
  let validUntil = WEEKDAYS(holdingDays).toISOString().slice(0, 10);
  let windowNote = `~${holdingDays} trading days`;
  const erDays = earnings?.daysUntil;
  if (erDays != null && erDays >= 0 && erDays < holdingDays) {
    validUntil = earnings.earningsDate ? earnings.earningsDate.slice(0, 10) : validUntil;
    windowNote = `cut short by the earnings report (${erDays <= 0 ? 'imminent' : `in ${erDays} days`}) — re-analyze after the print`;
  }
  const tradeWindow = {
    horizon,
    holdingDays,
    validUntil,
    note: windowNote,
  };

  // ---- LLM narrative (only when a provider key exists) --------------------
  // Uses the multi-model ensemble: N cheap models run the same prompt in
  // parallel and vote; consensus is honest uncertainty signaling.
  //
  // COST CONTROL: the narrative + ensemble + majority tone are the expensive
  // outputs, so they are cached per symbol for 24h (engine-version keyed,
  // earnings-overrun aware, ?refresh bypass). The quant score and soft vote
  // recompute live — a cache hit still reflects today's price and trend; only
  // the prose and the multi-model vote are reused.
  let narrative;
  let llmTone;
  let ensemble = null;
  let llmUsage = null;
  let researchFromCache = false;
  // Key ownership: OPENROUTER_API_KEY lives in svc-llm only (compose env_file).
  // Verdict always delegates the ensemble to svc-llm in full depth; svc-llm
  // falls back to its deterministic local engine when keyless (consensus null
  // → no tone → no soft vote), so verdict never needs the key itself.
  if (depth === 'full') {
    // Single-flight + 24h research cache. Two concurrent verdicts for the same
    // symbol must not both run the (expensive) ensemble: the FIRST caller
    // registers a promise; later callers await it and share its outcome.
    // refresh=1 skips the cache read but still joins an in-flight run.
    const inflightKey = `${clean}|${earnings?.earningsDate || ''}`;
    const inflightMap = (generateVerdict.inflight ??= new Map());
    const inflight = inflightMap.get(inflightKey);
    const cached = !inflight && !opts.refresh ? readResearchCache(clean, earnings?.earningsDate || null) : null;
    if (cached) {
      narrative = cached.narrative;
      ensemble = cached.ensemble || null;
      llmTone = cached.tone;
      // The cache records what the analysis cost when it was generated — a
      // cached verdict reports that historical spend, not $0.
      llmUsage = cached.usage || null;
      researchFromCache = true;
    } else if (inflight) {
      const shared = await inflight.catch(() => null);
      if (shared) {
        narrative = shared.narrative;
        ensemble = shared.ensemble;
        llmTone = shared.tone;
        llmUsage = shared.usage;
        researchFromCache = true;
      }
    } else {
      const run = (async () => {
        try {
          const llm = await callPeer('llm', '/ensemble', {
            ctx,
            method: 'POST',
            body: {
              symbol: clean,
              companyName: name,
              currentPrice: price,
              technicalSummary: { rsi14, trendShortTerm: trend === 'up' ? 'BULLISH' : trend === 'down' ? 'BEARISH' : 'NEUTRAL' },
              sentimentScore: news.sentimentScore,
              newsHeadlines: news.newsItems.map((n) => n.title),
              keyFinancials: { trailingPE: fundamentals?.peRatio },
              // P1-1 (ground the narrative): the deterministic score receipts so
              // every model writes from the same numbers the UI shows.
              quantBreakdown: quant.breakdown,
              grounding: 'every number you state must come from the provided data; do not invent figures',
            },
            timeoutMs: 90_000,
          });
          const freshNarrative = llm?.narrative || llm?.deepAnalysis;
          const freshEnsemble = llm?.votes ? { consensus: llm.consensus, agreeing: llm.agreeing, of: llm.of, votes: llm.votes } : null;
          const freshTone = llm?.consensus === 'BUY' ? 'BULLISH' : llm?.consensus === 'SELL' ? 'BEARISH' : llm?.consensus === 'HOLD' ? 'NEUTRAL' : undefined;
          const freshUsage = llm?.usage || null;
          if (freshNarrative) {
            writeResearchCache(clean, earnings?.earningsDate || null, { narrative: freshNarrative, ensemble: freshEnsemble, tone: freshTone, usage: freshUsage });
          }
          return { narrative: freshNarrative, ensemble: freshEnsemble, tone: freshTone, usage: freshUsage };
        } catch (err) {
          appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `LLM ensemble failed for ${clean}: ${err.message}` });
          return null;
        } finally {
          inflightMap.delete(inflightKey);
        }
      })();
      inflightMap.set(inflightKey, run);
      const shared = await run;
      if (shared) {
        narrative = shared.narrative;
        ensemble = shared.ensemble;
        llmTone = shared.tone;
        llmUsage = shared.usage;
      }
    }
  }

  // Soft LLM vote: adjust action only when quant score sits within ±15 of a boundary
  const quantAction = action;
  if (llmTone) {
    const boundaries = [-35, -15, 15, 35];
    const nearBoundary = boundaries.some((b) => Math.abs(score - b) <= 15);
    if (nearBoundary) {
      if (llmTone === 'BULLISH' && action === 'HOLD' && score >= -15) action = 'BUY';
      else if (llmTone === 'BEARISH' && action === 'HOLD' && score <= 15) action = 'SELL';
      else if (llmTone === 'BULLISH' && action === 'SELL' && score >= -35) action = 'HOLD';
      else if (llmTone === 'BEARISH' && action === 'BUY' && score <= 35) action = 'HOLD';
    }
  }
  // P1-1 (audit the soft-vote): every nudge that actually flips the action is
  // logged as a first-class trace event — quant said one thing, the LLM
  // ensemble tone moved it.
  if (llmTone && action !== quantAction) {
    appLog.info({
      requestId: ctx?.requestId,
      traceId: ctx?.traceId,
      span: 'verdict.softvote',
      symbol: clean,
      quantAction,
      llmTone,
      score,
      finalAction: action,
      msg: `soft-vote nudge: quant ${quantAction} → ${action} (llmTone ${llmTone}, score ${score})`,
    });
  }

  // ---- Levels & strategy --------------------------------------------------
  const supports = levels?.supports ?? [];
  const resistances = levels?.resistances ?? [];
  let stopTargets = {};
  try {
    stopTargets = getStopLossAndTargets(candles, action);
  } catch (err) {
    appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `stop/targets failed for ${clean}: ${err.message}` });
  }

  const strategy = buildStrategy({
    action, price, name, trend, supports, resistances,
    stop: stopTargets.stopLoss, t1: stopTargets.target1, t2: stopTargets.target2,
    rsi14, atr14: levels?.atr14,
  });

  const summary = buildSummary(clean, name, action, score, trend, rsi14, news.sentimentScore);

  // ---- Risk plan: computed numbers, not prose (P0-2 audit fix) --------------
  // stop/target come from levels (pivot + 2*ATR); entry is the nearest support
  // below price, else price - 0.5*ATR. R:R and $1k-account sizing are computed
  // server-side so the UI never shows an LLM-authored trade plan.
  const atr14v = levels?.atr14;
  const supBelow = (supports || []).filter((s) => s < price).sort((a, b) => b - a)[0];
  const entryLow = supBelow ?? (atr14v ? price - 0.5 * atr14v : null);
  const stop = stopTargets.stopLoss;
  const riskPerShare = stop != null && stop < price ? price - stop : null;

  // ---- Target geometry (target-geometry audit fix) ---------------------------
  // If the structure target1 yields < 1.5R, extend target1 to at least
  // price ± 1.5*riskPerShare and target2 to at least price ± 2.5*riskPerShare
  // (2dp) — BUT only within structure: an extended target may not reach past
  // the nearest overhead resistance (long side) / nearest support below
  // (short side, mirrored) by more than 1 ATR. If even 1.5R is unreachable
  // within structure, the plan is NOT tradable at current levels — wait.
  // (Mirrored short-side handling is the same audit rationale applied to SELL
  // plans; BUY/long geometry matches the audit text verbatim.)
  let target1 = stopTargets.target1 ?? null;
  let target2 = stopTargets.target2 ?? null;
  let tradable = true;
  let geometryNote;
  let rewardRisk = riskPerShare && target1 != null ? ((target1 - price) / riskPerShare) : null;
  if (target1 != null && riskPerShare != null && riskPerShare > 0) {
    const long = target1 > price;
    const structLvl = long
      ? (resistances || []).filter((r) => r > price).sort((a, b) => a - b)[0]
      : (supports || []).filter((s) => s < price).sort((a, b) => b - a)[0];
    // Structure ceiling/floor: nearest structure level ± 1 ATR of tolerance.
    const cap = structLvl != null ? (long ? structLvl + (atr14v ?? 0) : structLvl - (atr14v ?? 0)) : (long ? Infinity : -Infinity);
    if (rewardRisk != null && Math.abs(rewardRisk) < 1.5) {
      const ext1 = long ? price + 1.5 * riskPerShare : price - 1.5 * riskPerShare;
      const ext2 = long ? price + 2.5 * riskPerShare : price - 2.5 * riskPerShare;
      const ext1WithinStructure = long ? ext1 <= cap : ext1 >= cap;
      if (ext1WithinStructure) {
        target1 = long ? Math.max(target1, ext1) : Math.min(target1, ext1);
        // target2: extend to 2.5R only when that also stays within structure;
        // otherwise keep the structure target but stay monotonic vs target1.
        const ext2WithinStructure = long ? ext2 <= cap : ext2 >= cap;
        if (ext2WithinStructure) {
          target2 = long ? Math.max(target2 ?? target1, ext2) : Math.min(target2 ?? target1, ext2);
        } else {
          target2 = target2 != null ? (long ? Math.max(target2, target1) : Math.min(target2, target1)) : target1;
        }
        rewardRisk = (target1 - price) / riskPerShare;
      } else {
        tradable = false;
        geometryNote = 'no valid plan at current levels — wait';
      }
    }
  }
  const rr1 = rewardRisk;

    // ---- Time-to-target ETA (first-passage drift model) ------------------------
  // Replaces the naive |target - price| / ATR14 division: ATR is daily RANGE,
  // not drift, and first-passage time under drift+diffusion scales with the
  // diffusion term. mu = mean of the last 20 daily log closes' returns,
  // signed TOWARD the target (negated for SELL plans where target1 < price).
  // sigma = population std-dev of those same returns. For a target T with
  // ratio r = ln(T/price), an honest ETA exists only when the drift toward
  // the target beats the diffusion hurdle sigma^2/2; then
  // eta = ceil(r / (drift - sigma^2/2)) trading days (min 1). Otherwise the
  // trend does not support reaching the target — eta is null (unreliable).
  let etaT1 = null;
  let etaT2 = null;
  {
    const closes = candles.slice(-20).map((c) => Number(c?.close)).filter((n) => Number.isFinite(n) && n > 0);
    if (closes.length >= 2) {
      const rets = [];
      for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
      if (rets.length >= 1) {
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
        // Drift measured TOWARD the target direction (SELL plan → -average).
        const etaFor = (tgt) => {
          if (tgt == null || !(price > 0) || !(tgt > 0)) return null;
          const signedRatio = Math.log(tgt / price);
          if (!Number.isFinite(signedRatio)) return null;
          const dist = Math.abs(signedRatio);
          if (dist === 0) return 1;
          // driftToward > 0 means the recent trend points at this target.
          const driftToward = signedRatio > 0 ? mean : -mean;
          if (!(driftToward > variance / 2)) return null; // diffusion dominates — no honest ETA
          const eta = Math.ceil(dist / (driftToward - variance / 2));
          return Number.isFinite(eta) && eta > 0 ? Math.max(1, eta) : null;
        };
        etaT1 = etaFor(target1);
        etaT2 = etaFor(target2);
      }
    }
  }
  const etaReliable = etaT1 != null && etaT2 != null;

const tradePlan = {
    entry: entryLow != null ? Number(entryLow.toFixed(2)) : null,
    entryHigh: Math.round(price * 100) / 100,
    stop: stop != null ? Number(stop.toFixed(2)) : null,
    target1: target1 != null ? Number(target1.toFixed(2)) : null,
    target2: target2 != null ? Number(target2.toFixed(2)) : null,
    etaTarget1Days: etaT1,
    etaTarget2Days: etaT2,
    etaReliable,
    riskPerShare: riskPerShare != null ? Number(riskPerShare.toFixed(2)) : null,
    rewardRisk: rr1 != null ? Number(Math.abs(rr1).toFixed(2)) : null,
    riskPct: riskPerShare != null && price > 0 ? Number(((riskPerShare / price) * 100).toFixed(2)) : null,
    lowRR: rr1 != null && Math.abs(rr1) < 1.5,
    // Geometry audit: false = even 1.5R is unreachable within structure — the
    // daily report and UI should treat this as "wait", not a tradeable plan.
    tradable,
    ...(geometryNote ? { note: geometryNote } : {}),
    gapWarning: 'Stops are not guaranteed on gaps — size for the gap, not the stop.',
  };

  // ---- AiVerdict shape (src/types/verdict.ts) ------------------------------
  return {
    symbol: clean,
    name,
    price: Math.round(price * 100) / 100,
    asOf: Date.now(),
    verdict: { action, confidence, calibrated: confidenceCalibrated, horizon, summary },
    tradeWindow,
    tradePlan,
    breakdown: quant.breakdown,
    earnings,
    meta: { depth, researchCached: researchFromCache, engineVersion: VERDICT_ENGINE_VERSION, llmUsage, calibrated: confidenceCalibrated },
    levels: {
      target1: stopTargets.target1,
      target2: stopTargets.target2,
      stopLoss: stopTargets.stopLoss,
      supports,
      resistances,
      sma20,
      sma50,
      sma200,
      rsi14,
      atr14: levels?.atr14,
      week52High: levels?.week52High,
      week52Low: levels?.week52Low,
    },
    drivers: {
      bullish: news.bullish,
      bearish: news.bearish,
      newsItems: news.newsItems,
    },
    strategy,
    fundamentals,
    technicals: { trend, rsi14, sentimentScore: news.sentimentScore },
    aiNarrative: narrative,
    ensemble,
    disclaimer: DISCLAIMER,
  };
}

// ---- Strategy/summary builders (verbatim logic from aiVerdictService) -----
function buildStrategy(args) {
  const { action, price, name, trend, supports, resistances, stop, t1, t2 } = args;
  const p = (v) => (v === undefined ? undefined : `$${v.toFixed(2)}`);

  const headline =
    action === 'BUY'
      ? `${name}: constructive setup — the model rates ${name.split(' ')[0]} a BUY with a ${trend === 'up' ? 'rising' : trend === 'down' ? 'mixed' : 'flat'} trend backdrop.`
      : action === 'SELL'
      ? `${name}: caution warranted — the model rates ${name.split(' ')[0]} a SELL; trend and momentum argue against new buying.`
      : `${name}: no clear edge right now — the model rates ${name.split(' ')[0]} ${action}; wait for a stronger signal before committing capital.`;

  const plan = [];
  const minGap = Math.max(price * 0.005, args.atr14 ?? 0); // entry zone at least one ATR deep (min 0.5% of price)
  const zoneCandidates = supports.filter((s) => s < price - minGap).sort((a, b) => b - a);
  const nearestSupport = zoneCandidates.length
    ? zoneCandidates[0]
    : price - Math.max((args.atr14 ?? price * 0.01) * 1.5, price * 0.015);
  if (action === 'BUY') {
    if (nearestSupport !== undefined && nearestSupport < price) {
      plan.push(`Consider building a position in the entry zone between ${p(nearestSupport)} (nearest support) and ${p(price)} (current price).`);
    }
    if (t1) plan.push(`First profit target: ${p(t1)}${t2 ? `, stretch target: ${p(t2)}` : ''}. Scale out gradually rather than selling everything at once.`);
    if (stop) plan.push(`Protect capital: if the price closes below ${p(stop)}, exit the position — that level breaks the support the idea is built on.`);
  } else if (action === 'SELL') {
    if (stop) plan.push(`For existing holders, the risk line is ${p(stop)} — a close above it invalidates the bearish case; consider trimming before that.`);
    if (t1) plan.push(`Downside objective: ${p(t1)}${t2 ? `, then ${p(t2)}` : ''}. Do not chase the stock lower.`);
    plan.push('New money should stay on the sidelines until trend and momentum improve.');
  } else {
    if (nearestSupport !== undefined) plan.push(`Watch the ${p(nearestSupport)} support area — a firm hold there with improving news could set up a buying opportunity.`);
    if (resistances.length) plan.push(`Overhead resistance sits near ${p(resistances[0])}; a breakout above it on strong volume would be the bullish trigger.`);
    plan.push('Re-run this verdict after the next earnings report or a significant news event.');
  }
  if (args.rsi14 !== undefined) {
    if (args.rsi14 > 70) plan.push(`Momentum is stretched (RSI ${args.rsi14.toFixed(0)}) — the stock is overbought, so avoid buying into a spike.`);
    else if (args.rsi14 < 30) plan.push(`Momentum is washed out (RSI ${args.rsi14.toFixed(0)}) — the stock is oversold, so avoid panic-selling at the lows.`);
  }

  const riskNote = stop
    ? `Risk is defined by the stop at ${p(stop)} (${Math.abs(((price - stop) / price) * 100).toFixed(1)}% from the current price of ${p(price)}). Position size so that hitting the stop costs no more than 1–2% of your total portfolio.`
    : `Insufficient price history to compute a precise stop. If trading, use a hard stop no further than 5–8% below your entry near ${p(price)} and keep the position small.`;

  return { headline, entry: nearestSupport !== undefined ? `${p(nearestSupport)} – ${p(price)}` : undefined, plan, riskNote };
}

function buildSummary(symbol, name, action, score, trend, rsi14, sentimentScore) {
  const trendText = trend === 'up' ? 'trading above its key moving averages (long-term uptrend)' : trend === 'down' ? 'trading below its key moving averages (long-term downtrend)' : 'moving sideways between its key averages';
  const rsiText = rsi14 === undefined ? '' : rsi14 > 70 ? ' momentum is overbought' : rsi14 < 30 ? ' momentum is oversold' : ' momentum is in the neutral zone';
  const newsText = sentimentScore > 10 ? ' news flow is supportive' : sentimentScore < -10 ? ' news flow is negative' : ' news flow is mixed';
  const tone = action === 'BUY' ? 'favorable' : action === 'SELL' ? 'unfavorable' : 'balanced';
  return `${name} (${symbol}) scores ${score > 0 ? '+' : ''}${score}/100. The stock is ${trendText},${rsiText}${newsText}, giving a ${tone} overall picture. Composite rating: ${action}.`;
}

// ---- HTTP surface ----
const started = await startService({
  name: 'svc-verdict',
  port: Number(process.env.PORT || 8003),
  healthDeps: async () => {
    const deps = {};
    for (const peer of ['market-data', 'news', 'edgar', 'llm']) {
      try {
        const base = await resolveService(peer, null);
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
        deps[peer] = res.ok ? 'up' : 'down';
      } catch {
        deps[peer] = 'unreachable';
      }
    }
    return { ok: true, peers: deps };
  },
});
const { app, listen, close } = started;
// Fastify runs with logger:false, so app.log is a NO-OP null logger — routing
// service logs through it swallowed every appLog.* line (request-completion
// logs come from lib.mjs's own pino logger). Use a real service logger.
appLog = logger('svc-verdict');

// ---- Daily Top-15 research run ---------------------------------------------
initDailyReport({ resolveService, httpClient, log: appLog, appLog, generateVerdict });
app.get('/daily-report', async () => getDailyReport());
app.post('/daily-report/run', async (req, reply) => {
  try {
    const report = await runDailyReport('manual', req.traceCtx);
    return reply.status(report.skipped ? 409 : 200).send(report);
  } catch (err) {
    appLog.warn({ requestId: req.traceCtx?.requestId, msg: `daily-report/run failed: ${err.message}`, error: err.message, stack: err.stack });
    return reply.status(502).send({ error: err.message });
  }
});

app.post('/verdict', async (req, reply) => {
  const symbol = req.body?.symbol;
  if (!symbol) return reply.status(400).send({ error: 'body.symbol is required' });
  try {
    return await generateVerdict(symbol, req.traceCtx, { depth: String(req.body?.depth || 'full'), refresh: req.body?.refresh === true });
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/verdict/:symbol', async (req, reply) => {
  try {
    return await generateVerdict(req.params.symbol, req.traceCtx, verdictOptsFromQuery(req));
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

// UI-contract compatible: GET /verdict?symbol=NVDA (same shape as the legacy Next.js route)
// + depth=quant (zero-token alert checks) and refresh=1 (force regeneration).
function verdictOptsFromQuery(req) {
  return {
    depth: String(req.query?.depth || 'full'),
    refresh: req.query?.refresh === '1' || req.query?.refresh === 'true',
  };
}

app.get('/verdict', async (req, reply) => {
  const symbol = req.query?.symbol;
  if (!symbol) return reply.status(400).send({ error: 'query.symbol is required' });
  try {
    return await generateVerdict(symbol, req.traceCtx, verdictOptsFromQuery(req));
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

await listen();
appLog.info({ msg: `svc-verdict ready (engine ${VERDICT_ENGINE_VERSION})` });

// Daily Top-15: catch up if today's run is missing, then schedule 08:30 ET daily.
scheduleDailyReport();
catchUpDailyReport();
