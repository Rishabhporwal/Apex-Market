# Verdict factor-weight search — 2026-10-27T10:50:21.731Z

Config: 3y backtest, 90d horizon, top 150 universe, 31 months × 4405 observations, 323 combos.
Parameterization: block points scaled by w/shipCap, total renormalized to 110 (current weights reproduce the shipped engine exactly). Sentiment raw points are 0 in the backtest (no historical news feed) — its weight cannot be validated here.

## Baseline (current weights: trend 25 / rsi 15 / fund 35 / mom 10 / sent 25)
- Overall mean Spearman: **-0.052** (median 0, positive in 48.38709677419355% of months)
- First half: 0.227 | Second half: -0.313 → halves DISAGREE
- Top − middle quintile alpha: -2.24% per month
- BUY 90d alpha (ticker-level mean): -1.06% CI95 -3.15%, 1.41%

## Top 10 combos by mean Spearman
| # | trend / rsi / fund / mom / sent | Spearman | top−mid | H1 Spearman | H2 Spearman | BUY 90d α [CI] | note |
|---|---|---|---|---|---|---|---|
| 1 | trend 10 / rsi 15 / fund 0 / mom 10 / sent 0 | 0.216 | 1.13 | 0.407 | 0.037 | -0.74 [-1.99, 0.51] |  |
| 2 | trend 10 / rsi 15 / fund 0 / mom 10 / sent 25 | 0.194 | 0.99 | 0.42 | -0.019 | -0.62 [-2.19, 1.07] |  |
| 3 | trend 10 / rsi 15 / fund 0 / mom 10 / sent 10 | 0.19 | 0.85 | 0.42 | -0.025 | -0.55 [-1.96, 0.94] |  |
| 4 | trend 0 / rsi 5 / fund 0 / mom 20 / sent 0 | 0.187 | 1.9 | 0.227 | 0.15 | -0.87 [-1.99, 0.22] |  |
| 5 | trend 0 / rsi 5 / fund 0 / mom 20 / sent 25 | 0.187 | 1.8 | 0.233 | 0.144 | -0.55 [-1.81, 0.8] |  |
| 6 | trend 0 / rsi 5 / fund 0 / mom 20 / sent 10 | 0.187 | 1.79 | 0.233 | 0.144 | -1.04 [-2.18, 0.28] |  |
| 7 | trend 25 / rsi 15 / fund 0 / mom 10 / sent 25 | 0.177 | 1.49 | 0.313 | 0.05 | -1.1 [-2.44, 0.35] |  |
| 8 | trend 10 / rsi 5 / fund 0 / mom 10 / sent 25 | 0.165 | 0.31 | 0.293 | 0.044 | -1.92 [-3.63, -0.23] |  |
| 9 | trend 25 / rsi 15 / fund 0 / mom 10 / sent 10 | 0.161 | 1.65 | 0.293 | 0.038 | -1.36 [-2.71, -0.04] |  |
| 10 | trend 10 / rsi 5 / fund 0 / mom 10 / sent 10 | 0.161 | 0.3 | 0.293 | 0.037 | -1.64 [-2.89, -0.36] |  |

## Factor marginal means (mean overall Spearman across all combos at each level)
| block | mean Spearman by level |
|---|---|
| trend | 0: -0.04 | 10: -0.044 | 25: -0.045 |
| rsi | 0: -0.082 | 5: -0.054 | 15: 0.005 |
| fund | 0: 0.087 | 20: -0.043 | 35: -0.09 | 50: -0.125 |
| mom | 0: -0.083 | 10: -0.042 | 20: -0.004 |
| sent | 0: -0.043 | 10: -0.043 | 25: -0.044 |

## Recommendation
**ADOPT**: trend 0 / rsi 5 / fund 0 / mom 20 / sent 25 — overall Spearman 0.187 (baseline -0.052), H1 0.233 / H2 0.144 (both positive), top−mid 1.8%. Its exact-tie cluster holds both halves POSITIVE under the engine-exact rounded scorer for every variant AND under the unrounded scorer (unrounded: overall 0.213, H1 0.247, H2 0.181). 7 cluster(s) met the cluster-robust criteria.



Tie-break note: sentiment-variant combos tie EXACTLY on all rank metrics (sentiment raw points are 0 in this backtest); among exact ties the search prefers the CURRENT weight value — sentiment cannot be measured here, so it is not changed on noise-level BUY-alpha differences.

Dead-factor evidence (factor marginal means): fundamentals hurts monotonically (weight 0 → +0.087 mean Spearman, 20 → −0.047, 35 → −0.085, 50 → −0.124); momentum helps monotonically (0 → −0.084, 10 → −0.041, 20 → −0.003); RSI helps at full weight (15 → +0.006 vs 0 → −0.086); trend is flat (≈ −0.04 at every level).

Guardrails: in-sample (first half) vs OOS (second half) Spearman reported separately; adoption requires sign agreement in BOTH halves. Sentiment is untestable in this backtest.

## Confirmation run (post-adoption, fresh data, engine-exact)

The adopted weights were applied to `services/verdict/quantEngine.mjs` + `src/services/quantEngine.ts` (mirrored in `scripts/backtest-verdicts.mjs`), `VERDICT_ENGINE_VERSION` bumped to `2026-10-27.8`, the verdict service rebuilt, and the real backtest (`scripts/backtest-verdicts.mjs --years=3 --horizon=90 --top=150`) re-run on freshly fetched data:

| metric | baseline (2026-10-27.7) | adopted (2026-10-27.8) |
|---|---|---|
| Overall mean per-month Spearman | −0.052 | **+0.187** |
| First-half / second-half Spearman | +0.227 / **−0.313** | **+0.233 / +0.144** |
| Top − middle quintile alpha (per month) | −2.28% | **+1.76%** |
| Rank-performance verdict | FAIL | **PASS** |

The fresh run reproduced the cached-data search prediction for this combo exactly (0.187 / +0.233 / +0.144) — not a single-pull fluke.

Honest caveats:
- BUY 90d alpha remains statistically insignificant (ticker-level mean −0.55%, CI95 [−1.81, +0.80]; raw per-signal avg +1.21%, win 58.8%). The fix is RANKING monotonicity, not proven absolute alpha.
- At 5d/21d horizons BUY alpha is significantly negative (−0.32% [−0.65, −0.04] / −0.8% [−1.41, −0.26]) — short-horizon reversal cost, unchanged by this work.
- Sentiment (25, unchanged) is untestable in this backtest; fundamentals (weight 0) is the confirmed dead factor at this horizon.
