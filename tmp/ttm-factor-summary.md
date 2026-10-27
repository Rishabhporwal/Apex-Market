# Verdict factor-weight search — 2026-10-27T12:54:05.668Z

Config: 3y backtest, 90d horizon, top 600 universe, 31 months × 17911 observations, 2915 combos (7-block grid incl. growth_ttm / margin_ttm).
Parameterization: block points scaled by w/shipCap, total renormalized to 110 (current weights reproduce the shipped engine exactly). Sentiment raw points are 0 in the backtest (no historical news feed) — its weight cannot be validated here.
TTM factors: growth_ttm / margin_ttm are rolling-4-quarter revenue growth / net margin, computed per checkpoint from facts_quarterly + 10-K FY facts with the filed_at look-ahead guard (only facts FILED before the checkpoint are visible; derived Q4 carries the 10-K filing date). Coverage honesty: 17/31 months have any TTM data (quarterly warehouse reaches back ~40 months), avg 39.5% of the snapshot per covered month — TTM blocks are silent before the first covered month.

## Baseline (current weights: trend 0 / rsi 5 / fund 0 / mom 20 / sent 25 / gtmm 0 / mtmm 0)
- Overall mean Spearman: **0.229** (median 0.3, positive in 61.3% of months)
- First half: 0.373 | Second half: 0.094
- Top − middle quintile alpha: 2.35% per month
- BUY 90d alpha (ticker-level mean): -1.76% CI95 -2.53%, -1%

## Top 10 combos by mean Spearman
| # | trend / rsi / fund / mom / sent / gtmm / mtmm | Spearman | top−mid | H1 Spearman | H2 Spearman | BUY 90d α [CI] | note |
|---|---|---|---|---|---|---|---|
| 1 | trend 10 / rsi 15 / fund 0 / mom 0 / sent 25 / gtmm 20 / mtmm 0 | 0.335 | -0.07 | 0.473 | 0.206 | -2.52 [-3.97, -1.23] |  |
| 2 | trend 10 / rsi 15 / fund 0 / mom 0 / sent 0 / gtmm 20 / mtmm 0 | 0.335 | -0.07 | 0.473 | 0.206 | -1.26 [-2.05, -0.39] |  |
| 3 | trend 10 / rsi 15 / fund 0 / mom 0 / sent 10 / gtmm 20 / mtmm 0 | 0.332 | -0.08 | 0.473 | 0.2 | -2.84 [-4.1, -1.48] |  |
| 4 | trend 0 / rsi 15 / fund 0 / mom 10 / sent 10 / gtmm 10 / mtmm 0 | 0.294 | 0.22 | 0.567 | 0.038 | -1.4 [-2.13, -0.65] |  |
| 5 | trend 10 / rsi 15 / fund 20 / mom 20 / sent 0 / gtmm 10 / mtmm 0 | 0.294 | 0.97 | 0.58 | 0.025 | -2.56 [-3.39, -1.69] |  |
| 6 | trend 10 / rsi 15 / fund 20 / mom 20 / sent 10 / gtmm 10 / mtmm 0 | 0.29 | 0.91 | 0.607 | -0.006 | -2.82 [-3.74, -1.91] |  |
| 7 | trend 10 / rsi 15 / fund 0 / mom 10 / sent 0 / gtmm 20 / mtmm 0 | 0.29 | 0.62 | 0.5 | 0.094 | -1.92 [-2.77, -1.09] |  |
| 8 | trend 10 / rsi 15 / fund 20 / mom 20 / sent 10 / gtmm 20 / mtmm 0 | 0.287 | 1.14 | 0.607 | -0.012 | -2.44 [-3.43, -1.41] |  |
| 9 | trend 10 / rsi 15 / fund 0 / mom 0 / sent 0 / gtmm 10 / mtmm 0 | 0.284 | -0.44 | 0.473 | 0.106 | -1.38 [-2.18, -0.58] |  |
| 10 | trend 10 / rsi 15 / fund 0 / mom 0 / sent 10 / gtmm 10 / mtmm 0 | 0.284 | -0.5 | 0.473 | 0.106 | -1.32 [-2.11, -0.49] |  |

## Factor marginal means (mean overall Spearman across all combos at each level)
| block | mean Spearman by level |
|---|---|
| trend | 0: -0.001 | 10: 0.021 | 25: 0.032 |
| rsi | 0: -0.026 | 5: 0.008 | 15: 0.07 |
| fund | 0: 0.105 | 20: 0.031 | 35: -0.017 | 50: -0.052 |
| mom | 0: -0.046 | 10: 0.025 | 20: 0.072 |
| sent | 0: 0.017 | 10: 0.017 | 25: 0.017 |
| growthTtm | 0: 0.018 | 10: 0.017 | 20: 0.016 |
| marginTtm | 0: 0.041 | 10: 0.012 | 20: -0.002 |

## Factor verdict (from marginal means)
- **trend**: ALIVE (mean Spearman rises monotonically with weight)
- **rsi**: ALIVE (mean Spearman rises monotonically with weight)
- **fund**: DEAD (anti-predictive: mean Spearman falls monotonically with weight)
- **mom**: ALIVE (mean Spearman rises monotonically with weight)
- **sent**: NEUTRAL/FLAT (no consistent ranking contribution)
- **growthTtm**: NEUTRAL/FLAT (no consistent ranking contribution)
- **marginTtm**: DEAD (anti-predictive: mean Spearman falls monotonically with weight)

## Recommendation
**NO CHANGE**: no combo met the adoption criteria under the cluster-robust evaluation (CLUSTER-robust: combos whose exact-tie cluster (differing only in blocks with identically-zero raw contribution — sentiment here) has positive mean Spearman in BOTH halves under the engine-exact rounded scorer for EVERY variant, plus the same criteria under the unrounded scorer; overall Spearman >= baseline + 0.10 and top-quintile-minus-middle > 0. The growth_ttm/margin_ttm blocks have NONZERO raw contribution in TTM-covered months, so variants differing in them are NOT exact ties — each must earn adoption on its own metrics; the winner additionally requires its neighbor variants (other grid levels of the same TTM blocks) to be reported for sign consistency. Rationale: variants that differ only in a zero-contribution block are the same ranking up to rounding tie-breaks — if the OOS sign depends on which variant you pick, it is not robust.). 0 of 972 clusters qualified. The honest result is that the current weights are not meaningfully beatable on this data — see factor marginal means for which blocks look dead.

Closest miss: the highest-Spearman combo (trend 10 / rsi 15 / fund 0 / mom 0 / sent 25 / gtmm 20 / mtmm 0, Spearman 0.335, H1 0.473 / H2 0.206) FAILS the quintile-monotonicity requirement — top−middle = -0.07% (top quintile at/below the middle means the score does not rank the top of the book correctly, regardless of the overall correlation). It buys its correlation by zeroing momentum (mom 0) and loading growth_ttm — not adoptable under the shipped rule.



Tie-break note: sentiment-variant combos tie EXACTLY on all rank metrics (sentiment raw points are 0 in this backtest); among exact ties the search prefers the CURRENT weight value — sentiment cannot be measured here, so it is not changed on noise-level BUY-alpha differences.

Dead-factor evidence (factor marginal means — mean overall Spearman across all combos at each weight level; monotone falls with weight = dead factor, rises = alive):
- trend: 0 → -0.001, 10 → 0.021, 25 → 0.032
- rsi: 0 → -0.026, 5 → 0.008, 15 → 0.07
- fund: 0 → 0.105, 20 → 0.031, 35 → -0.017, 50 → -0.052
- mom: 0 → -0.046, 10 → 0.025, 20 → 0.072
- sent: 0 → 0.017, 10 → 0.017, 25 → 0.017
- growthTtm: 0 → 0.018, 10 → 0.017, 20 → 0.016
- marginTtm: 0 → 0.041, 10 → 0.012, 20 → -0.002

Guardrails: in-sample (first half) vs OOS (second half) Spearman reported separately; adoption requires sign agreement in BOTH halves. Sentiment is untestable in this backtest. TTM factors are only measurable in TTM-covered months (see coverage above) — a TTM-based winner rests on a shorter OOS sample, say so when reporting.
