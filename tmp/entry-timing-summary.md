# Entry-timing / universe-selection lab — 2026-10-27

Config: 3y backtest, top 600 universe, 31 months × 17,874 scored observations, 5,552 BUY observations across 558 tickers. Pipeline identical to scripts/reversal-lab.mjs / weight-search.mjs (same universe, look-ahead-free fundamentals, sector percentiles, ticker-level bootstrap 1000 draws seed 42, halves = 15/16 months). Baseline = shipped engine v3. Slices evaluated on BUY signals: **sector, market-cap band, dollar-volume tercile, price band, per-month, and candle-only regime proxies** (SPY 20d realized vol, breadth = share of checkpoint universe above own SMA200, SPY vs its month mean).

Data: cached candles tmp/bt-data-cache-600.json. Market caps from Yahoo quotes (static, as-of fetch date — classification only, disclosed look-ahead; cross-checked against look-ahead-free dollar-volume terciles). Lab script: scripts/entry-timing-lab.mjs; raw output: data/entry-timing-slices.json. Nothing committed; no quantEngine/weight-search changes.

## Headline

**No tested slice supports an executable universe-selection gate.** The 90d SPY-relative BUY drag (ticker-level −1.76 [−2.47, −1.07]; halves −1.83 / −2.62) is negative in nearly every slice, and the two slices that pool to positive alpha (mega-cap ≥$200B, price $50–100) fail for the same decisive reason: **within those slices the engine's ranking is dead** (Spearman 0.02–0.08 vs 0.216 universe-wide; top−mid ≤ 0 everywhere). Their positive means are slice *beta* — mega-cap/IT outperformance concentrated in the 2026 rally — not engine alpha, and a gate cannot harvest beta it cannot rank.

## Task 1 — BUY 90d alpha by slice (ticker-level mean [CI95], %, gross; H1/H2 = first/second sample half)

### All BUY (reference)
| slice | mean [CI95] | H1 [CI95] | H2 [CI95] | n | mean fwd 90d |
|---|---|---|---|---|---|
| ALL | −1.76 [−2.47, −1.07] | −1.83 [−2.65, −0.97] | −2.62 [−3.78, −1.43] | 5552 | +4.31 |

### Sector
| sector | mean [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| Information Technology | +3.97 [1.02, 7.67] | −1.75 | +11.78 [5.95, 18.41] | 653 |
| Energy | +4.19 [0.65, 7.95] | −6.41 [−11.33, −1.58] | +8.51 [2.46, 15.93] | 211 |
| Financials | −0.27 [−1.48, 0.87] | +1.08 | −5.64 [−7.76, −3.55] | 714 |
| Health Care | −1.28 [−2.84, 0.57] | −1.87 | −1.73 | 382 |
| Utilities | −0.77 [−3.12, 1.90] | +2.65 | −5.40 [−7.77, −3.47] | 249 |
| Real Estate | −0.63 [−3.38, 2.02] | −0.20 | −1.50 | 138 |
| Consumer Staples | −1.66 [−3.73, 0.21] | +2.14 | −6.21 [−10.47, −2.15] | 297 |
| Industrials | −2.63 [−3.95, −1.29] | −2.72 [−4.52, −1.07] | −3.85 [−5.93, −1.64] | 969 |
| Consumer Discretionary | −3.66 [−5.82, −1.64] | −1.66 | −5.67 [−8.18, −3.26] | 733 |
| Communication Services | −3.84 [−10.24, 2.09] | −0.52 | −6.29 | 169 |
| Materials | −4.92 [−7.07, −2.96] | −4.85 [−7.57, −2.28] | −5.25 [−8.86, −1.79] | 284 |
| Unknown (null sector) | −4.83 [−7.06, −2.79] | −4.55 [−7.39, −1.68] | −6.01 [−9.78, −2.40] | 753 |

No sector is positive in BOTH halves. IT and Energy pool positive but each has a significantly negative half (IT H1 −1.75, Energy H1 −6.41) — their positive means are one-sided regime moves (2026 tech/energy runs), not persistent slice alpha. The defensive half-flips (Staples +2.14→−6.21, Utilities +2.65→−5.40) kill any sector gate.

### Market-cap band (static Yahoo cap, disclosed look-ahead in classification)
| band | mean [CI95] | H1 [CI95] | H2 [CI95] | n | mean fwd 90d |
|---|---|---|---|---|---|
| cap ≥ $200B | **+2.63 [0.94, 4.35]** | +0.57 [−1.82, 2.62] | +5.36 [0.68, 10.65] | 680 | +7.39 |
| cap $50–200B | +0.31 [−0.95, 1.72] | −0.20 | −1.36 | 1732 | +5.59 |
| cap $10–50B | −2.21 [−3.22, −1.26] | −1.59 [−2.83, −0.27] | −3.57 [−5.20, −1.95] | 2126 | +3.73 |
| cap < $10B | −5.37 [−7.15, −3.64] | −5.99 [−8.82, −3.13] | −6.56 [−9.57, −3.58] | 1010 | +1.31 |

Clear monotone size gradient — the drag IS concentrated in small/mid caps — but only the mega-cap band pools positive, and weakly (H1 CI crosses 0).

### Dollar-volume tercile (look-ahead-free size/liquidity proxy, per-checkpoint)
| tercile | mean [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| high | −1.42 [−2.67, −0.05] | −0.93 | −1.65 | 2125 |
| low | −1.51 [−3.07, 0.00] | −1.73 | −1.93 | 1579 |
| mid | −2.18 [−3.68, −0.47] | −0.78 | −3.67 [−5.58, −1.84] | 1848 |

The clean (no look-ahead) liquidity proxy shows ALL terciles negative — liquid names are merely "least negative". The cap-band gradient is real but does not cross zero on a look-ahead-free basis.

### Price band (at checkpoint)
| band | mean [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| $50–100 | +1.97 [0.06, 4.01] | +0.87 [−1.01, 3.06] | +1.78 [−1.80, 5.34] | 1204 |
| < $50 | −0.85 [−2.96, 1.47] | −2.44 | +0.19 | 1070 |
| $100–400 | −1.94 [−3.12, −0.82] | −1.64 [−2.82, −0.47] | −2.34 [−4.43, −0.07] | 2720 |
| ≥ $400 | −3.53 [−7.02, 0.17] | −3.37 [−5.81, −1.34] | −4.83 [−8.63, −0.78] | 558 |
| < $400 (user ask) | −1.49 [−2.25, −0.74] | −1.57 [−2.48, −0.60] | −1.97 [−3.40, −0.44] | 4994 |

The <$400-vs-higher split goes the OPPOSITE way of the cap result: high nominal price (mostly mega-caps) is worse. Price level is economically arbitrary (splits move with index level); the $50–100 pocket is not significant in either half.

### Regime (candles only)
| regime | mean [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| SPY vol low | −0.58 [−1.74, 0.71] | −1.30 [−2.47, −0.02] | +1.68 | 1137 |
| SPY vol mid | −1.49 [−2.50, −0.50] | −0.24 | −3.79 [−5.59, −2.07] | 1056 |
| SPY vol high | −0.37 [−1.85, 1.17] | +1.84 [0.29, 3.40] | −0.55 | 1232 |
| breadth low | +0.48 [−0.61, 1.59] | +2.99 [1.77, 4.22] | −0.82 [−2.29, 0.64] | 1904 |
| breadth mid | −0.81 [−2.01, 0.48] | +2.36 [1.01, 3.74] | −2.85 [−4.44, −1.28] | 1644 |
| breadth high | −2.09 [−3.07, −1.05] | −2.09 | n/a (all high-breadth months fall in H1) | 2004 |
| SPY above month mean | −2.96 [−3.90, −2.06] | +1.52 | −4.51 [−5.63, −3.39] | 1804 |
| SPY below month mean | +1.33 [−0.09, 2.83] | −1.16 [−2.15, −0.20] | +8.05 [4.49, 11.69] | 1621 |

Every regime slice flips sign across halves. SPY-below-mean (+1.33) and low-breadth (+0.48) look like "buy weakness" windows, but both are driven by the second half (2025-04/2026 recoveries) with significantly negative first halves — not robust.

### Per-month (BUY, signal-level means)
| month | n | 21d α | 90d α | 90d fwd | SPY vol | breadth | Spearman |
|---|---|---|---|---|---|---|---|
| 2024-01 | 60 | +1.33 | +3.67 | 7.95 | 10.9 | 0.74 | 0.9 |
| 2024-02 | 115 | +0.90 | +0.27 | 4.98 | — | 0.73 | 0.6 |
| 2024-03 | 229 | −1.88 | −5.54 | −1.40 | — | 0.84 | 0.1 |
| 2024-04 | 303 | −0.55 | −2.75 | 3.19 | 13.2 | 0.73 | −0.1 |
| 2024-05 | 270 | −3.43 | −0.91 | 4.94 | 9.3 | 0.71 | −0.6 |
| 2024-06 | 247 | +1.10 | +3.72 | 8.45 | — | 0.64 | −0.5 |
| 2024-07 | 133 | +0.91 | +4.31 | 10.93 | 14.4 | 0.73 | 0.9 |
| 2024-08 | 224 | +0.05 | +5.15 | 11.70 | 18.4 | 0.74 | 1.0 |
| 2024-09 | 319 | +0.91 | −2.53 | 2.96 | — | 0.71 | 0.8 |
| 2024-10 | 247 | +0.12 | −0.66 | 2.54 | 10.8 | 0.72 | 0.0 |
| 2024-11 | 104 | −5.74 | −3.98 | −4.03 | — | 0.73 | −0.1 |
| 2024-12 | 299 | +3.50 | +3.31 | −2.39 | 14.0 | 0.58 | 0.2 |
| 2025-01 | 189 | −0.24 | +1.42 | −6.67 | — | 0.63 | 0.7 |
| 2025-02 | 189 | −0.61 | +2.46 | 1.94 | — | 0.55 | 0.9 |
| 2025-03 | 206 | +0.53 | +2.41 | 9.47 | 20.0 | 0.42 | 0.6 |
| 2025-04 | 175 | −0.46 | −3.41 | 12.22 | 51.9 | 0.33 | −0.5 |
| 2025-05 | 78 | −2.32 | −2.58 | 6.10 | 16.8 | 0.51 | −0.7 |
| 2025-06 | 118 | −1.36 | −2.02 | 6.03 | — | 0.51 | −0.2 |
| 2025-07 | 131 | −1.37 | −2.85 | 4.73 | 6.5 | 0.62 | 0.9 |
| 2025-08 | 169 | −1.49 | −4.93 | −1.28 | 10.1 | 0.65 | 0.7 |
| 2025-09 | 151 | −1.82 | −1.70 | 2.61 | 6.3 | 0.63 | 0.3 |
| 2025-10 | 126 | +0.32 | +5.01 | 6.10 | 13.7 | 0.62 | 0.7 |
| 2025-11 | 92 | −0.67 | +9.12 | 10.25 | — | 0.58 | 0.3 |
| 2025-12 | 169 | +3.59 | +10.06 | 1.91 | 8.2 | 0.60 | 1.0 |
| 2026-01 | 100 | +4.65 | +3.43 | 6.67 | — | 0.66 | 0.9 |
| 2026-02 | 174 | −2.20 | −3.42 | 4.85 | — | 0.64 | 0.2 |
| 2026-03 | 264 | −0.09 | +5.99 | 21.80 | 18.2 | 0.44 | 0.2 |
| 2026-04 | 80 | −3.24 | −0.67 | 2.67 | 11.6 | 0.56 | −0.9 |
| 2026-05 | 251 | +2.43 | +0.98 | 3.03 | — | 0.55 | −1.0 |
| 2026-06 | 152 | −0.60 | −4.37 | −1.05 | 17.7 | 0.58 | 0.0 |
| 2026-07 | 188 | −2.78 | −8.73 | −5.17 | 12.1 | 0.66 | −0.9 |

Positive 90d months: 14/31; the worst month (2026-07, −8.73) is recent, and negative months are spread across both halves and all regimes — the drag is not month-concentrated (consistent with the reversal-lab finding).

## Task 2 — gate analysis for the two candidate slices

### Gate A: restrict candidates to cap ≥ $200B (51 tickers)
| | mean 90d α [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| BEFORE (all BUY) | −1.76 [−2.47, −1.07] | −1.83 | −2.62 | 5552 |
| AFTER (kept) | +2.63 [0.94, 4.35] | +0.57 [−1.82, 2.62] | +5.36 [0.68, 10.65] | 680 (12.3%) |
| Dropped | −2.20 [−2.95, −1.44] | −2.09 | −3.50 | 4872 |

**Why this gate fails despite the pooled improvement:**
1. **First half is not positive** (+0.57 [−1.82, 2.62]) — the improvement exists only in H2.
2. **H2 alpha is concentrated**: the top 2 months contribute 60.6% of total slice alpha (2026-03 +33.2%, 2026-02 +10.9%, 2026-01 +9.1% — the mega-cap/AI melt-up). Excluding that quarter the slice is ~flat-to-negative.
3. **Within-slice ranking is dead**: restricted universe per-month Spearman 0.078 (vs 0.216 full), top−mid **−3.91** (NEGATIVE), positive-Spearman share 51.9%. The engine cannot pick the winners inside the mega-cap slice — the pooled +2.63 is the slice's beta vs SPY, not selection skill. A live gate would deliver slice beta at best, and the beta is a single-quarter regime artifact.
4. Mega × sector cross-tab confirms: the whole effect is mega-cap IT (+5.87 [2.03, 9.74], H2 +16.85 [5.69, 28.69], H1 −1.18); mega-cap Financials/Staples/Discretionary are ~0 or negative.

### Gate B: restrict candidates to price $50–100 (213 tickers)
| | mean 90d α [CI95] | H1 | H2 | n |
|---|---|---|---|---|
| AFTER (kept) | +1.97 [0.06, 4.01] | +0.87 [−1.01, 3.06] | +1.78 [−1.80, 5.34] | 1204 (21.7%) |
| Dropped | −2.05 [−3.03, −1.05] | −2.28 | −2.54 | 4348 |

Overall CI lower bound is +0.06 (knife-edge), NEITHER half is significant, within-slice ranking is dead (Spearman 0.065, top−mid −0.26, positive share 48.4%), and a nominal price band has no economic rationale that survives a regime change. Not adoptable.

### Gate C: cap ≥ $50B (the "large-cap product" version, 211 tickers, keeps 43% of BUYs)
| | mean 90d α [CI95] | H1 | H2 |
|---|---|---|---|
| AFTER (kept) | +0.87 [−0.16, 2.06] | −0.02 | +0.27 [−1.48, 2.22] |

Not significant overall or in either half; within-slice ranking dead (Spearman 0.023, top−mid −0.38). Cutting 57% of candidate flow for a statistically insignificant improvement — rejected.

## Recommendation: **NO UNIVERSE GATE — current picks do not beat SPY at 90d in any tested slice.**

1. **Honest conclusion:** across 4 sector groupings × 12 slices, 4 cap bands, 3 liquidity terciles, 4+2 price bands, 8 regime slices, and 31 months, no slice shows alpha that is (a) significantly positive overall, (b) positive in both sample halves, AND (c) paired with working within-slice ranking. Conditions (a)+(b) are met only by mega-cap ≥$200B and nominally by $50–100 price; condition (c) is met by NONE — within-slice Spearman 0.02–0.08 and top−mid ≤ 0 everywhere tested. The drag is broad-based with a size gradient (small/mid caps worst), not a fixable concentration.
2. **Do not adopt a cap/price/sector gate.** The positive slice means are beta from the 2026 mega-cap rally; a gate would convert the product into an unhedged large-cap/mega-cap bet with no in-slice selection edge, and would survive only while that regime lasts.
3. **Recommended direction — relative-to-cash reporting.** The BUY cohort makes money in absolute terms: mean 90d forward return +4.31% (signal-level +4.29% in the shipped report, win rate 56.8%), and 21d drag is the only meaningfully negative window. Make absolute (and/or T-bill-relative) return the primary reported metric, and present SPY-relative numbers as secondary with the weighting disclosed: signal-weighted 90d alpha is +0.21 while equal-weight-of-tickers is −1.76 — the SPY-relative sign is a benchmark/weighting choice, not a stable property of the picks. If a market benchmark must be shown, benchmark against the tradable universe itself (equal-weight or cap-weight top-600), which is what the engine actually selects from.
4. If the product later requires SPY-relative claims, the honest path is not slicing the current score but re-testing whether a size-aware benchmark (e.g., Russell-1000 instead of SPY) closes the small/mid-cap gap — that is a reporting change, not a signal change, and should be validated on fresh data before any claim.

Method notes: lab universe requires ≥253 closes per checkpoint (same as reversal-lab; Spearman baseline 0.206 there vs 0.229 shipped — internally consistent comparisons). Cap bands use static (today's) market caps for classification only; the look-ahead-free dollar-volume terciles confirm the same ordering with all terciles negative. Regime proxies (SPY vol, breadth) are computed from cached candles only; SPY-vol is unavailable for a few cache-edge months (marked "—"). Full per-slice data: data/entry-timing-slices.json; run log: tmp/entry-timing-run.log.
