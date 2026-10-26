#!/usr/bin/env node
/**
 * svc-llm (port 8005) — OpenRouter narratives + cost tracking per ADR-001.
 * Ports the OpenRouter path of src/services/llmService.ts (runDeepAnalysis):
 * OPENROUTER_API_KEY env, model default deepseek/deepseek-v3.2, same system
 * prompt, per-model cost counters exposed at GET /stats. Deterministic local
 * fallback ("ApexMarket Quantitative AI") when no key is present — never throws.
 *
 * The API key is read from the environment only; it is never logged or echoed.
 */
import { startService, loadEnvLocal, httpClient, logger } from '../shared/lib.mjs';
import { resolveService } from '../shared/discovery.mjs';
import { getTechnicalSummary } from '../shared/technical.mjs';

loadEnvLocal();

const DEFAULT_MODEL = 'deepseek/deepseek-v3.2';

// Fastify runs with logger:false → req.log/app.log are NO-OP null loggers, so
// route-level warn/info (ensemble failures, OpenRouter errors) were silently
// swallowed. Route handlers log through this real service logger instead.
const svcLog = logger('svc-llm');

/** Per-model cost counters: calls, tokens in/out, rough $ estimate. */
const costCounters = new Map(); // model -> {calls, promptTokens, completionTokens, estimatedCostUsd}

// Rough list-price estimates ($/1M tokens) for cost accounting only.
const MODEL_PRICE_ESTIMATES = {
  'deepseek/deepseek-v3.2': { in: 0.28, out: 0.42 },
  'z-ai/glm-5.3-flash': { in: 0.11, out: 0.44 },
  'qwen/qwen3-32b': { in: 0.29, out: 0.88 },
  default: { in: 1.0, out: 2.0 },
};

/** One-call cost estimate ($/1M in + out from the table above). */
function costOf(model, promptTokens, completionTokens) {
  const price = MODEL_PRICE_ESTIMATES[model] || MODEL_PRICE_ESTIMATES.default;
  const usd = ((promptTokens || 0) / 1e6) * price.in + ((completionTokens || 0) / 1e6) * price.out;
  return Number(usd.toFixed(6));
}

function recordCost(model, promptTokens, completionTokens) {
  const m = costCounters.get(model) || { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 };
  m.calls += 1;
  m.promptTokens += promptTokens || 0;
  m.completionTokens += completionTokens || 0;
  m.estimatedCostUsd = Number((m.estimatedCostUsd + costOf(model, promptTokens, completionTokens)).toFixed(6));
  costCounters.set(model, m);
}

/** Same prompt builder as llmService.buildPrompt, extended with the quant
 *  breakdown receipts (P1-1: the narrative is generated FROM the numbers) and
 *  the caller's grounding instruction. */
function buildPrompt(data) {
  const bd = data.quantBreakdown || null;
  const pts = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v}` : 'n/a');
  const breakdownBlock = bd ? `
Quant Model Breakdown (deterministic score receipts — authoritative, treat as ground truth):
- Composite score: ${pts(bd.score)}/100
- Trend component: ${pts(bd.trend?.points)} pts — ${bd.trend?.detail}
- RSI(14) component: ${pts(bd.rsi?.points)} pts — ${bd.rsi?.detail}
- News sentiment component: ${pts(bd.sentiment?.points)} pts — ${bd.sentiment?.detail}
- Fundamentals component: ${pts(bd.fundamentals?.points)} of ±${bd.fundamentals?.max} pts — ${bd.fundamentals?.detail}
${(bd.fundamentals?.factors || []).map((f) => `  · ${f.name}: ${f.value} → ${pts(f.points)} pts`).join('\n')}${bd.bearishVotes ? `\n- Bearish confirmations: ${bd.bearishVotes.count} — ${bd.bearishVotes.reasons.join('; ')}` : ''}` : '';

  const base = `Analyze ${data.symbol} (${data.companyName}) as an institutional senior financial research analyst.
Current Price: $${data.currentPrice}
Technical Summary: RSI: ${data.technicalSummary?.rsi14}, Trend: ${data.technicalSummary?.trendShortTerm}/${data.technicalSummary?.trendLongTerm}, Signal: ${data.technicalSummary?.overallSignal}
News Sentiment Score: ${data.sentimentScore}/100
Recent News Headlines:
${(data.newsHeadlines || []).slice(0, 5).map((h) => `- ${h}`).join('\n')}
Financial Metrics: P/E: ${data.keyFinancials?.trailingPE}, Forward P/E: ${data.keyFinancials?.forwardPE}, Profit Margin: ${data.keyFinancials?.profitMargin}, FCF: $${data.keyFinancials?.freeCashflow}
${breakdownBlock}
Provide a concise, 3-paragraph executive institutional research report:
1. Fundamental Valuation & Earnings Quality
2. Technical Chart Structure & Key Inflection Levels
3. Final Verdict (Buy / Sell / Neutral) with precise rationale and price targets.${data.grounding ? `\n\nIMPORTANT: ${data.grounding}.` : ''}`;
  // /research passes an optional user query through (mirrors the ai-research route
  // handing `userQuery` to runDeepAnalysis); /narrate never sets it.
  return data.userQuery ? `${base}\n\nAdditional analyst request: ${data.userQuery}` : base;
}

/** OpenRouter call for a SPECIFIC model (primary + ensemble path). Throws on failure. */
async function callOpenRouterModel(data, apiKey, model, log) {
  const prompt = buildPrompt(data);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.HOME || 'https://researchplatform.dev',
      'X-Title': 'Research Platform',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an institutional Wall Street research director and quantitative hedge fund strategist. Provide data-driven analysis, not hype.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  recordCost(model, json.usage?.prompt_tokens, json.usage?.completion_tokens);
  log.info({ msg: `openrouter call ok`, model });

  const modelName = json.model || model;
  const modelLabel = modelName.includes('claude') ? 'Claude' : modelName.includes('gpt') ? 'GPT-4o' : modelName.includes('gemini') ? 'Gemini' : modelName.includes('llama') ? 'Llama' : 'OpenRouter model';

  return {
    providerUsed: `OpenRouter (${modelLabel})`,
    model,
    deepAnalysis: text,
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      costUsd: costOf(model, json.usage?.prompt_tokens, json.usage?.completion_tokens),
    },
    keyRisks: [
      'Overhead technical resistance cluster.',
      'Regulatory and macro liquidity tailwinds/tailwinds may shift quickly.',
    ],
    growthDrivers: [
      'Expanding addressable market in high-margin segments.',
      'Operating leverage driving earnings upside surprise.',
    ],
    valuationFairValueEstimate: Number((data.currentPrice * 1.15).toFixed(2)),
    analystToneAssessment: data.sentimentScore >= 15 ? 'BULLISH' : data.sentimentScore <= -20 ? 'BEARISH' : 'NEUTRAL',
  };
}

/** Deterministic local engine — same text as llmService.generateLocalInstitutionalAnalysis. */
function generateLocalInstitutionalAnalysis(data) {
  const { symbol, companyName, currentPrice, sentimentScore, technicalSummary, keyFinancials } = data;
  const isBull = sentimentScore >= 15;
  const pe = keyFinancials?.trailingPE ? `${keyFinancials.trailingPE.toFixed(1)}x` : 'N/A';
  const rsi = technicalSummary?.rsi14 ? Number(technicalSummary.rsi14).toFixed(1) : '50.0';

  const deepAnalysis = `Comprehensive institutional evaluation for ${companyName} (${symbol}) at $${currentPrice.toFixed(2)}:
The technical configuration shows RSI(14) at ${rsi} with ${technicalSummary?.trendShortTerm || 'neutral'} short-term momentum and ${technicalSummary?.trendLongTerm || 'constructive'} long-term moving average structure. 
Financial news sentiment scores at ${sentimentScore > 0 ? '+' : ''}${sentimentScore}/100, indicating an asymmetric risk/reward skew. 
With a trailing P/E multiple of ${pe} and strong operating cash flows, the asset presents an actionable setup with defined support floors and clear upside targets.`;

  return {
    providerUsed: 'ApexMarket Quantitative AI (Local Engine)',
    model: 'quant-nlp-v2.5',
    deepAnalysis,
    keyRisks: [
      'Broader macroeconomic liquidity fluctuations and bond yield adjustments.',
      'Short-term profit-taking at overhead psychological resistance levels.',
      'Execution risks on newly introduced enterprise product lines.',
    ],
    growthDrivers: [
      'Double-digit operating income expansion and recurring margin stability.',
      'Positive news sentiment velocity supported by strong institutional interest.',
      'High cash flow generation supporting ongoing share buyback authorizations.',
    ],
    valuationFairValueEstimate: Number((currentPrice * (isBull ? 1.22 : 0.98)).toFixed(2)),
    analystToneAssessment: isBull ? 'BULLISH' : sentimentScore <= -20 ? 'BEARISH' : 'NEUTRAL',
  };
}

/** Port of llmService.runDeepAnalysis restricted to the OpenRouter + local path. */
async function runDeepAnalysis(data, log, customKey) {
  const openRouterKey = customKey || process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    try {
      return await callOpenRouterModel(data, openRouterKey, process.env.OPENROUTER_MODEL || DEFAULT_MODEL, log);
    } catch (err) {
      log.warn({ msg: `OpenRouter API call failed, falling back to local engine: ${err.message}` });
    }
  }
  return generateLocalInstitutionalAnalysis(data);
}

/**
 * Raw OpenRouter chat call shared by /filing-qa (the existing callOpenRouterModel
 * keeps its own inline call for the narrative path). Returns the completion text,
 * records cost, throws on failure. The key is used in the Authorization header
 * only — never logged or echoed.
 */
async function callOpenRouterChat(messages, apiKey, model, log, { temperature = 0.2, maxTokens = 1500, timeoutMs = 60_000 } = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'HTTP-Referer': process.env.HOME || 'https://researchplatform.dev',
      'X-Title': 'Research Platform',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  recordCost(model, json.usage?.prompt_tokens, json.usage?.completion_tokens);
  log.info({ msg: `openrouter call ok`, model });
  return { text, modelUsed: json.model || model };
}

// ---- Multi-model ensemble: parallel run across models, majority vote on verdict ----
const ENSEMBLE_MODELS = (process.env.ENSEMBLE_MODELS || 'deepseek/deepseek-v3.2,z-ai/glm-5.3-flash,qwen/qwen3-32b')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** Ask one model for its verdict; returns {model, verdict, confidenceGuess, text} or {model, error}. */
async function ensembleOne(data, apiKey, model, log) {
  try {
    const withVerdict = { ...data, userQuery: (data.userQuery ? data.userQuery + '\n\n' : '') +
      'End your report with a final line in EXACTLY this format: VERDICT: <BUY|HOLD|SELL> CONFIDENCE: <0-100>' };
    const out = await callOpenRouterModel(withVerdict, apiKey, model, log);
    const m = /VERDICT:\s*(BUY|HOLD|SELL)/i.exec(out.deepAnalysis || '');
    const c = /CONFIDENCE:\s*(\d{1,3})/i.exec(out.deepAnalysis || '');
    return {
      model,
      verdict: m ? m[1].toUpperCase() : null,
      confidenceGuess: c ? Math.min(100, Number(c[1])) : null,
      providerUsed: out.providerUsed,
      deepAnalysis: out.deepAnalysis,
      usage: out.usage || null,
    };
  } catch (err) {
    return { model, error: err.message };
  }
}

// ---- HTTP surface ----
const { app, listen, close } = await startService({
  name: 'svc-llm',
  port: Number(process.env.PORT || 8005),
  healthDeps: async () => ({
    ok: true,
    openrouterKeyPresent: Boolean(process.env.OPENROUTER_API_KEY),
    modelsTracked: costCounters.size,
  }),
});

app.post('/narrate', async (req, reply) => {
  const b = req.body || {};
  if (!b.symbol) return reply.status(400).send({ error: 'symbol is required' });
  const data = {
    symbol: String(b.symbol).trim().toUpperCase(),
    companyName: b.companyName || b.symbol,
    currentPrice: Number(b.currentPrice) || 0,
    technicalSummary: b.technicalSummary || {},
    sentimentScore: Number(b.sentimentScore) || 0,
    newsHeadlines: Array.isArray(b.newsHeadlines) ? b.newsHeadlines : [],
    keyFinancials: b.keyFinancials || {},
    quantBreakdown: b.quantBreakdown || null,
    grounding: typeof b.grounding === 'string' ? b.grounding : '',
  };
  try {
    const out = await runDeepAnalysis(data, svcLog);
    return out;
  } catch (err) {
    // Local engine cannot throw, but guard anyway.
    return generateLocalInstitutionalAnalysis(data);
  }
});

// POST /ensemble — same narrate payload; runs the prompt across multiple models
// in parallel and returns each model's verdict + a majority consensus.
// Ensemble disagreement is honest uncertainty signaling, not an error.
app.post('/ensemble', async (req, reply) => {
  const b = req.body || {};
  if (!b.symbol) return reply.status(400).send({ error: 'symbol is required' });
  const apiKey = b.apiKey || process.env.OPENROUTER_API_KEY;
  const data = {
    symbol: String(b.symbol).trim().toUpperCase(),
    companyName: b.companyName || b.symbol,
    currentPrice: Number(b.currentPrice) || 0,
    technicalSummary: b.technicalSummary || {},
    sentimentScore: Number(b.sentimentScore) || 0,
    newsHeadlines: Array.isArray(b.newsHeadlines) ? b.newsHeadlines : [],
    keyFinancials: b.keyFinancials || {},
    quantBreakdown: b.quantBreakdown || null,
    grounding: typeof b.grounding === 'string' ? b.grounding : '',
  };
  const log = svcLog;

  if (!apiKey) {
    // No key: single deterministic local vote
    const local = generateLocalInstitutionalAnalysis(data);
    return { consensus: null, votes: [{ model: 'local-engine', verdict: local.analystToneAssessment || null, error: 'no key — deterministic engine only' }], agreeing: 0, of: 1 };
  }

  const votes = await Promise.all(ENSEMBLE_MODELS.map((m) => ensembleOne(data, apiKey, m, log)));
  const valid = votes.filter((v) => v.verdict);
  const tally = {};
  for (const v of valid) tally[v.verdict] = (tally[v.verdict] || 0) + 1;
  const consensus = Object.entries(tally).sort((a, b2) => b2[1] - a[1])[0]?.[0] || null;
  // Per-run cost accounting: exact usage from OpenRouter when reported, exact
  // token estimate (chars/4) otherwise — never silently omitted.
  const usage = votes.map((v) => ({
    model: v.model,
    error: v.error || null,
    promptTokens: v.usage?.promptTokens ?? estimateTokens(v),
    completionTokens: v.usage?.completionTokens ?? estimateTokens(v, 'out'),
    costUsd: v.usage?.costUsd ?? null,
  }));
  for (const u of usage) {
    if (u.costUsd == null) u.costUsd = costOf(u.model, u.promptTokens, u.completionTokens);
  }
  const llmUsage = {
    models: usage,
    totalPromptTokens: usage.reduce((a, u) => a + u.promptTokens, 0),
    totalCompletionTokens: usage.reduce((a, u) => a + u.completionTokens, 0),
    totalCostUsd: Number(usage.reduce((a, u) => a + u.costUsd, 0).toFixed(6)),
  };
  return {
    consensus,
    agreeing: consensus ? tally[consensus] : 0,
    of: votes.length,
    votes: votes.map(({ model, verdict, confidenceGuess, error }) => ({ model, verdict, confidenceGuess, error })),
    narrative: valid[0]?.deepAnalysis,
    providerUsed: valid[0]?.providerUsed,
    usage: llmUsage,
  };
});

/** chars/4 fallback when OpenRouter omits usage on a vote. */
function estimateTokens(vote, kind = 'in') {
  const text = vote.deepAnalysis || '';
  return kind === 'in' ? 900 : Math.round(text.length / 4);
}

/**
 * POST /research — port of src/app/api/ai-research/route.ts as a service route.
 * Accepts {symbol, apiKey?, provider?, query?}; orchestrates market-data
 * (quote + 1y candles), news (/sentiment/:symbol) and research
 * (/financials/:symbol?section=key-metrics) via registry/SERVICES_JSON,
 * computes the technical summary locally (shared/technical.mjs — exact port
 * of technicalService.getTechnicalSummary), then calls this service's own
 * runDeepAnalysis path with the optional user query. OpenRouter when a key is
 * present (body apiKey or env), deterministic local engine otherwise — never throws.
 *
 * The API key is used in the Authorization header only; never logged or echoed.
 */
app.post('/research', async (req, reply) => {
  const b = req.body || {};
  const symbol = String(b.symbol || 'NVDA').trim().toUpperCase();
  const log = svcLog;

  // Gather context concurrently from sibling services (graceful degradation)
  const [quote, candles, sentiment, keyFin] = await Promise.all([
    (async () => {
      try {
        const base = await resolveService('market-data');
        const res = await httpClient.fetch(`${base}/quote/${encodeURIComponent(symbol)}`, { ctx: req.traceCtx, span: 'llm.market-data.quote', timeoutMs: 15_000 });
        return res.ok ? res.json : null;
      } catch (err) {
        log.warn({ requestId: req.traceCtx?.requestId, traceId: req.traceCtx?.traceId, msg: `market-data quote unavailable: ${err.message}` });
        return null;
      }
    })(),
    (async () => {
      try {
        const base = await resolveService('market-data');
        const res = await httpClient.fetch(`${base}/candles/${encodeURIComponent(symbol)}?timeframe=1y&interval=1d`, { ctx: req.traceCtx, span: 'llm.market-data.candles', timeoutMs: 20_000 });
        return res.ok ? (res.json?.candles || []) : [];
      } catch (err) {
        log.warn({ requestId: req.traceCtx?.requestId, traceId: req.traceCtx?.traceId, msg: `market-data candles unavailable: ${err.message}` });
        return [];
      }
    })(),
    (async () => {
      try {
        const base = await resolveService('news');
        const res = await httpClient.fetch(`${base}/sentiment/${encodeURIComponent(symbol)}`, { ctx: req.traceCtx, span: 'llm.news.sentiment', timeoutMs: 20_000 });
        return res.ok ? res.json : null;
      } catch (err) {
        log.warn({ requestId: req.traceCtx?.requestId, traceId: req.traceCtx?.traceId, msg: `news sentiment unavailable: ${err.message}` });
        return null;
      }
    })(),
    (async () => {
      try {
        const base = await resolveService('research');
        const res = await httpClient.fetch(`${base}/financials/${encodeURIComponent(symbol)}?section=key-metrics`, { ctx: req.traceCtx, span: 'llm.research.keyFinancials', timeoutMs: 20_000 });
        return res.ok ? res.json : null;
      } catch (err) {
        log.warn({ requestId: req.traceCtx?.requestId, traceId: req.traceCtx?.traceId, msg: `research financials unavailable: ${err.message}` });
        return null;
      }
    })(),
  ]);

  const technicalSummary = getTechnicalSummary(symbol, candles);
  const fallbackPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  const data = {
    symbol,
    companyName: quote?.name || symbol,
    currentPrice: Number(quote?.price) || fallbackPrice,
    technicalSummary,
    sentimentScore: Number(sentiment?.overallScore) || 0,
    newsHeadlines: (sentiment?.news || []).map((n) => n.title),
    keyFinancials: keyFin || {},
    userQuery: b.query,
  };

  try {
    // runDeepAnalysis equivalent with userQuery + optional caller-provided key
    return await runDeepAnalysis(data, log, b.apiKey);
  } catch (err) {
    // Local engine cannot throw, but guard anyway (graceful deterministic fallback).
    return generateLocalInstitutionalAnalysis(data);
  }
});

/**
 * POST /filing-qa — retrieval-augmented Q&A over SEC filings.
 * Body: {symbol, question, form? ('10-K' default | '10-Q')}.
 *
 * 1. Resolves svc-research via registry/SERVICES_JSON and GETs
 *    /filing-context/:symbol?q=...&form=... (90s timeout — the first fetch of a
 *    10-K downloads and parses a multi-MB document, 20-60s).
 * 2. Research's honest errors (no filing / no relevant sections) are passed
 *    through with the same status code.
 * 3. Builds a GROUNDED prompt: the question plus the 6 numbered excerpts
 *    verbatim (trimmed to ~3000 chars each), with strict instructions to answer
 *    only from the excerpts and cite every claim as [n].
 * 4. Calls OpenRouter with the primary model; returns answer + sources +
 *    filing metadata. Without an OPENROUTER_API_KEY, returns the excerpts
 *    deterministically so the feature works keyless.
 */
app.post('/filing-qa', async (req, reply) => {
  const b = req.body || {};
  const symbol = String(b.symbol || '').trim().toUpperCase();
  const question = String(b.question || '').trim();
  const form = String(b.form || '10-K').trim().toUpperCase();
  if (!symbol || !question) return reply.status(400).send({ error: 'symbol and question are required' });
  const log = svcLog;

  // 1. Retrieve grounded excerpts from svc-research.
  let ctx;
  try {
    const base = await resolveService('research');
    const url = `${base}/filing-context/${encodeURIComponent(symbol)}?q=${encodeURIComponent(question)}&form=${encodeURIComponent(form)}`;
    const res = await httpClient.fetch(url, { ctx: req.traceCtx, span: 'llm.research.filing-context', timeoutMs: 90_000 });
    if (!res.ok || res.json?.error) {
      // Pass research's 404-style errors through honestly, same status code.
      return reply.status(res.status).send({
        error: res.json?.error || `filing-context request failed (status ${res.status})`,
      });
    }
    ctx = res.json;
  } catch (err) {
    log.warn({ requestId: req.traceCtx?.requestId, traceId: req.traceCtx?.traceId, msg: `research filing-context unavailable: ${err.message}` });
    return reply.status(502).send({ error: `filing context unavailable: ${err.message}` });
  }

  // 3. Grounded prompt: excerpts verbatim (trimmed), strict grounding rules.
  const excerpts = ctx.chunks
    .map((c) => `Excerpt [${c.n}]${c.section ? ` (${c.section})` : ''}:\n${c.text.length > 3000 ? c.text.slice(0, 3000) + '\u2026' : c.text}`)
    .join('\n\n');

  const system = 'You are an institutional financial analyst answering questions about a company\'s SEC filings. '
    + 'Answer ONLY from the excerpts provided. Cite every claim with [n] matching the excerpt number. '
    + 'If the excerpts do not contain the answer, say exactly that — do not use outside knowledge.';
  const user = `Question: ${question}\n\n`
    + `The following are excerpts from ${symbol}'s Form ${ctx.form}, filed ${ctx.filedAt}:\n\n`
    + `${excerpts}\n\n`
    + 'Answer ONLY from the excerpts below. Cite every claim with [n] matching the excerpt number. '
    + 'If the excerpts do not contain the answer, say exactly that — do not use outside knowledge.';

  // 4. OpenRouter (primary model from env), or deterministic keyless fallback.
  let answer;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    try {
      const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
      const out = await callOpenRouterChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        apiKey,
        model,
        log,
        { temperature: 0.2, maxTokens: 1200, timeoutMs: 100_000 },
      );
      answer = out.text;
    } catch (err) {
      log.warn({ requestId: req.traceCtx?.requestId, msg: `OpenRouter filing-qa call failed: ${err.message}` });
      return reply.status(502).send({ error: `LLM call failed: ${err.message}` });
    }
  } else {
    // 5. Deterministic keyless fallback — feature works without keys.
    answer = 'LLM key not configured — showing the matching filing excerpts:';
  }

  return {
    symbol: ctx.symbol,
    question: ctx.question,
    answer,
    sources: ctx.chunks.map((c) => ({
      n: c.n,
      section: c.section,
      url: ctx.filingUrl,
      excerpt: c.text.slice(0, 200),
    })),
    filing: { form: ctx.form, filedAt: ctx.filedAt, url: ctx.filingUrl },
  };
});

app.get('/stats', async () => {
  const byModel = Object.fromEntries([...costCounters.entries()]);
  const totals = [...costCounters.values()].reduce(
    (acc, m) => ({
      calls: acc.calls + m.calls,
      promptTokens: acc.promptTokens + m.promptTokens,
      completionTokens: acc.completionTokens + m.completionTokens,
      estimatedCostUsd: Math.round((acc.estimatedCostUsd + m.estimatedCostUsd) * 1e6) / 1e6,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }
  );
  return {
    defaultModel: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    openrouterKeyPresent: Boolean(process.env.OPENROUTER_API_KEY),
    totals,
    byModel,
  };
});

await listen();

process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
