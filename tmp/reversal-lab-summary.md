# Short-horizon reversal lab — 2026-10-27T12:31:48.447Z

Config: 3y backtest, top 600 universe, 31 months × 17874 observations, horizons 5/21/90d. Methodology identical to scripts/weight-search.mjs (same pipeline, same cluster-robust bootstrap: ticker-level alpha means, 1000 draws, seed 42). Baseline = shipped engine v3 (trend 0 / rsi 5 / fund 0 / mom 20 / sent 25). Scores unrounded unless noted; engine-exact rounded metrics in data/reversal-lab.json.

## Task 1 — where the reversal lives
Pooled quintile mean alpha (Q1=worst → Q5=best engine scores):
| horizon | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---|---|---|---|---|
| 5d | -0.26 | -0.22 | -0.26 | -0.09 | -0.11 |
| 21d | -0.64 | -0.62 | -0.57 | 0.1 | -0.52 |
| 90d | -0.71 | -1.8 | -1.96 | 0.12 | 0.4 |

BUY signals by prior-5d return bucket (mean alpha %, ticker-level):
| bucket | 5d | 21d | 90d |
|---|---|---|---|
| r5<=0 | -0.07 (n=2552) | -0.53 (n=2552) | 0.14 (n=2552) |
| r5 0..4% | -0.1 (n=2135) | -0.31 (n=2135) | -0.19 (n=2135) |
| r5 4..8% | -0.2 (n=599) | 0.45 (n=599) | 0.85 (n=599) |
| r5 >8% | 0.21 (n=266) | 2.98 (n=266) | 3.1 (n=266) |

BUY alpha halves (first / second half of the sample): 5d 0.18 / -0.25 | 21d -0.21 / -0.46 | 90d 0.69 / -0.01

Per-month BUY alpha is in data/reversal-lab.json (profile.perMonthBuy).

## Task 2 — variant grid (BUY alpha = ticker-level mean [CI95], gross of costs)
| variant | 90d Spearman | H1 / H2 | top−mid | BUY 5d α | BUY 21d α | BUY 90d α | note |
|---|---|---|---|---|---|---|---|
| v3 baseline (no fix) | 0.206 | 0.36 / 0.06 | 2.38 | -0.24 [-0.38, -0.08] | -0.86 [-1.16, -0.61] | -1.76 | **baseline** |
| damp momentum with 0.5× prior-21d | 0.19 | 0.35 / 0.04 | 1.62 | -0.19 [-0.34, -0.06] | -0.84 [-1.13, -0.55] | -1.84 |  |
| damp momentum with 1× prior-21d | 0.197 | 0.4 / 0.01 | 1.49 | -0.16 [-0.29, 0] | -0.76 [-1.02, -0.49] | -1.65 |  |
| damp momentum with 2× prior-21d | 0.152 | 0.43 / -0.11 | 1.04 | -0.14 [-0.27, -0.01] | -0.58 [-0.87, -0.33] | -1.39 |  |
| damp momentum with 1× prior-5d | 0.184 | 0.32 / 0.06 | 2.16 | -0.25 [-0.38, -0.12] | -0.87 [-1.14, -0.6] | -1.73 |  |
| damp momentum with 2× prior-5d | 0.19 | 0.35 / 0.04 | 1.62 | -0.23 [-0.38, -0.09] | -0.88 [-1.17, -0.6] | -1.75 |  |
| gate BUY when 5d move > +8% | 0.206 | 0.36 / 0.06 | 2.38 | -0.26 [-0.41, -0.12] | -0.97 [-1.26, -0.69] | -1.68 |  |
| gate BUY when 5d move > +12% | 0.206 | 0.36 / 0.06 | 2.38 | -0.25 [-0.39, -0.1] | -0.92 [-1.19, -0.65] | -1.7 |  |
| gate BUY when 21d move > +15% | 0.206 | 0.36 / 0.06 | 2.38 | -0.21 [-0.35, -0.06] | -0.84 [-1.13, -0.52] | -1.67 |  |

## Adoption criteria (as specified)
- Winner holds 90d Spearman sign in BOTH halves (unrounded AND engine-exact).
- Improves 21d BUY alpha vs baseline.
- Does not destroy 90d Spearman (within −0.03 of baseline, both scorers).
- damp21-l0.5: halves-positive=true, 21d improves=true (-0.86 → -0.84), 90d Spearman kept=true
- damp21-l1: halves-positive=true, 21d improves=true (-0.86 → -0.76), 90d Spearman kept=true
- damp21-l2: halves-positive=false, 21d improves=true (-0.86 → -0.58), 90d Spearman kept=false
- damp5-l1: halves-positive=true, 21d improves=false (-0.86 → -0.87), 90d Spearman kept=true
- damp5-l2: halves-positive=true, 21d improves=false (-0.86 → -0.88), 90d Spearman kept=true
- gate5-8: halves-positive=true, 21d improves=false (-0.86 → -0.97), 90d Spearman kept=true
- gate5-12: halves-positive=true, 21d improves=false (-0.86 → -0.92), 90d Spearman kept=true
- gate21-15: halves-positive=true, 21d improves=true (-0.86 → -0.84), 90d Spearman kept=true

## Recommendation: **NO ADOPT** (engine stays 2026-10-27.8)

The data REFUTES the short-horizon-reversal hypothesis for BUY names:

1. **The 5d/21d underperformance is broad-based, not a top-of-ranking reversal.** At 5d every score quintile underperforms SPY (Q1 −0.26 … Q5 −0.11); at 21d only Q4 is positive (+0.10) and the spread structure differs from 90d (Q1 −0.71 / Q2 −1.80 / Q3 −1.96 / Q4 +0.12 / Q5 +0.40). There is no monotone inversion concentrated in Q5.
2. **Among BUY signals, prior-5d return is POSITIVELY related to forward alpha** — r5 > +8% is the BEST cohort (+0.21% 5d, +2.98% 21d, +3.10% 90d), not the worst. Recent runners continue; they do not mean-revert.
3. **The overextension gate therefore removes the best signals and backfires**: gate r5>+8% demotes 266 BUYs and worsens 21d BUY alpha (−0.86 → −0.97; second half −0.45 → −0.72). Gates at +12% (5d) and +15% (21d) also fail to improve.
4. **5d damping is a no-op** (21d BUY alpha unchanged ±0.02); **21d damping at λ=2** improves 21d alpha (−0.86 → −0.58) but destroys the 90d ranking (Spearman 0.206 → 0.152, second half −0.106 NEGATIVE) → fails the two-halves gate. **λ=1** is the only variant meeting the letter of the criteria (H1 +0.40 / H2 +0.006, 21d α −0.86 → −0.76, Spearman 0.197), but the improvement is noise-level (CIs [−1.02,−0.48] vs baseline [−1.16,−0.61] overlap almost fully), the 21d alpha remains significantly NEGATIVE, first-half 21d alpha is unchanged (−0.21 → −0.21), and it costs 0.9pp of the top−mid spread. Adoption criteria are necessary, not sufficient — this is not a robust improvement, so it is not adopted.
5. The 21d BUY drag is persistent (both halves negative: −0.21 / −0.46) and not month-concentrated (worst: 2024-11 −5.74, 2024-05 −3.43, 2026-04 −3.24, 2026-07 −2.78).

**What this means:** the short-horizon BUY underperformance is not a momentum-reversal artifact that a reversal term can fix; it is a property of this score composition at short horizons (likely benchmark-relative timing + cost-free-window effects). Any future fix should target the broad 21d drag, not high-prior-return names. Honest baseline numbers to beat: 5d BUY α −0.24, 21d −0.86, 90d −1.76 (ticker-level, gross), 90d Spearman 0.206 (H1 0.36 / H2 0.063).

Method notes: lab universe requires ≥253 closes per checkpoint (SMA200 + 12-1 momentum), so its baseline (Spearman 0.206) sits slightly below the shipped top=600 report (0.229, ≥210 closes); all variant comparisons are on identical checkpoints, so the comparison is internally exact. Engine-exact (rounded) metrics in data/reversal-lab.json agree with the unrounded ones on every adoption-relevant sign.
