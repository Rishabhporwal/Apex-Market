#!/usr/bin/env node
/**
 * svc-verdict (port 8003) — verdict orchestration per ADR-001.
 * Stateless compute plane: calls svc-market-data (quote + 1y candles), svc-news
 * (drivers), svc-edgar (company fundamentals), svc-llm (narrative when key
 * present). Scoring is the EXACT quant logic from src/services/quantEngine.ts;
 * levels mirror src/services/levelsService.ts; response shape is the AiVerdict
 * from src/types/verdict.ts so the existing UI keeps working.
 */
import { startService, loadEnvLocal, traceCtx, httpClient } from '../shared/lib.mjs';
import { scoreVerdict } from './quantEngine.mjs';
import { computeLevels, getStopLossAndTargets } from './levels.mjs';

loadEnvLocal();

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
async function generateVerdict(symbol, ctx) {
  const clean = String(symbol).trim().toUpperCase();
  if (!clean) throw Object.assign(new Error('Symbol is required'), { statusCode: 400 });

  // ---- Gather inputs; each fetch degrades independently -------------------
  const [quoteRes, candlesRes, newsRes, edgarRes] = await Promise.allSettled([
    callPeer('market-data', `/quote/${encodeURIComponent(clean)}`, { ctx }),
    callPeer('market-data', `/candles/${encodeURIComponent(clean)}?timeframe=1y&interval=1d`, { ctx }),
    callPeer('news', `/drivers/${encodeURIComponent(clean)}`, { ctx }),
    callPeer('edgar', `/company/${encodeURIComponent(clean)}`, { ctx }),
  ]);

  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const candles = candlesRes.status === 'fulfilled' ? candlesRes.value?.candles ?? [] : [];
  const news = newsRes.status === 'fulfilled' && newsRes.value
    ? { newsItems: newsRes.value.newsItems ?? [], bullish: newsRes.value.bullish ?? [], bearish: newsRes.value.bearish ?? [], sentimentScore: newsRes.value.sentimentScore ?? 0 }
    : { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 };
  const edgarFundamentals = edgarRes.status === 'fulfilled' ? edgarRes.value?.fundamentals ?? null : null;
  for (const r of [quoteRes, candlesRes, newsRes, edgarRes]) {
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
  const quant = scoreVerdict({ price, candles, sentimentScore: news.sentimentScore, fundamentals: fundSrc });
  const { score, confidence } = quant;
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

  // ---- LLM narrative (only when a provider key exists) --------------------
  // Uses the multi-model ensemble: N cheap models run the same prompt in
  // parallel and vote; consensus is honest uncertainty signaling.
  let narrative;
  let llmTone;
  let ensemble = null;
  if (process.env.OPENROUTER_API_KEY) {
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
        },
        timeoutMs: 90_000,
      });
      narrative = llm?.narrative || llm?.deepAnalysis;
      ensemble = llm?.votes ? { consensus: llm.consensus, agreeing: llm.agreeing, of: llm.of, votes: llm.votes } : null;
      // Majority tone feeds the soft vote
      llmTone = llm?.consensus === 'BUY' ? 'BULLISH' : llm?.consensus === 'SELL' ? 'BEARISH' : llm?.consensus === 'HOLD' ? 'NEUTRAL' : undefined;
    } catch (err) {
      appLog.warn({ requestId: ctx?.requestId, traceId: ctx?.traceId, msg: `LLM ensemble failed for ${clean}: ${err.message}` });
    }
  }

  // Soft LLM vote: adjust action only when quant score sits within ±15 of a boundary
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

  // ---- AiVerdict shape (src/types/verdict.ts) ------------------------------
  return {
    symbol: clean,
    name,
    price: Math.round(price * 100) / 100,
    asOf: Date.now(),
    verdict: { action, confidence, horizon, summary },
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
appLog = app.log;

app.post('/verdict', async (req, reply) => {
  const symbol = req.body?.symbol;
  if (!symbol) return reply.status(400).send({ error: 'body.symbol is required' });
  try {
    return await generateVerdict(symbol, req.traceCtx);
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/verdict/:symbol', async (req, reply) => {
  try {
    return await generateVerdict(req.params.symbol, req.traceCtx);
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

// UI-contract compatible: GET /verdict?symbol=NVDA (same shape as the legacy Next.js route)
app.get('/verdict', async (req, reply) => {
  const symbol = req.query?.symbol;
  if (!symbol) return reply.status(400).send({ error: 'query.symbol is required' });
  try {
    return await generateVerdict(symbol, req.traceCtx);
  } catch (err) {
    return reply.status(err.statusCode || 500).send({ error: err.message });
  }
});

await listen();
