/**
 * Exact plain-JS port of sentimentService.generatePredictions
 * (src/services/sentimentService.ts) — the `predictiveInsight` block of the
 * legacy /api/sentiment payload. svc-news /sentiment/:symbol predates this
 * block, so the gateway mapping and svc-analytics use this port to keep the
 * monolith response shape byte-compatible without touching svc-news.
 */

export function generatePredictions(symbol, overallScore, articles) {
  let bias = 'SIDEWAYS_CONSOLIDATION';
  let projectedImpactRangePercent = [-1.5, 1.5];
  let confidence = 50;

  if (overallScore >= 40) {
    bias = 'POSITIVE_CATALYST';
    projectedImpactRangePercent = [
      Number((overallScore * 0.05).toFixed(1)),
      Number((overallScore * 0.12).toFixed(1)),
    ];
    confidence = Math.min(92, 60 + Math.round(overallScore * 0.3));
  } else if (overallScore >= 15) {
    bias = 'POSITIVE_CATALYST';
    projectedImpactRangePercent = [0.8, 3.5];
    confidence = 68;
  } else if (overallScore <= -40) {
    bias = 'NEGATIVE_CATALYST';
    projectedImpactRangePercent = [
      Number((overallScore * 0.12).toFixed(1)),
      Number((overallScore * 0.04).toFixed(1)),
    ];
    confidence = Math.min(92, 60 + Math.round(Math.abs(overallScore) * 0.3));
  } else if (overallScore <= -15) {
    bias = 'NEGATIVE_CATALYST';
    projectedImpactRangePercent = [-3.8, -0.6];
    confidence = 65;
  }

  // Extract top catalysts from articles
  const catalystsFound = Array.from(
    new Set(articles.filter((a) => a.catalystSummary).map((a) => a.catalystSummary))
  ).slice(0, 3);

  const topCatalysts = catalystsFound.length > 0 ? catalystsFound : [
    'Positive corporate execution sentiment in primary revenue drivers.',
    'Constructive sell-side analyst commentary on near-term multiple expansion.',
  ];

  const riskFactors = overallScore >= 0 ? [
    'Potential profit taking around psychological overhead resistance.',
    'Broader market equity index volatility (VIX spikes).',
    'Valuation multiple compression if bond yields tick upward.',
  ] : [
    'Downside momentum acceleration if institutional sell volume persists.',
    'Earnings revision cuts by major brokerage desks.',
    'Sustained negative coverage cycle until next quarterly filing.',
  ];

  const rationale = overallScore >= 20
    ? `Based on ${articles.length} analyzed recent news releases, media sentiment for ${symbol} is overwhelmingly constructive (Score: +${overallScore}/100). Key narratives center around robust operational delivery and analyst revisions, implying a favorable risk/reward asymmetric skew of [${projectedImpactRangePercent[0]}%, ${projectedImpactRangePercent[1]}%] over the near-term trading horizon.`
    : overallScore <= -20
    ? `Aggregated market sentiment for ${symbol} has shifted defensively (Score: ${overallScore}/100). Recent headlines highlight near-term operational or macro headwinds, indicating caution with a projected downward drift of [${projectedImpactRangePercent[0]}%, ${projectedImpactRangePercent[1]}%] until catalyst resolution.`
    : `Sentiment for ${symbol} sits in a balanced consolidation band (Score: ${overallScore}/100). Bullish operational milestones are currently matched by macro caution, indicating choppy or rangebound price discovery.`;

  return {
    bias,
    projectedImpactRangePercent,
    confidence,
    topCatalysts,
    riskFactors,
    rationale,
  };
}

/**
 * Given a svc-news /sentiment/:symbol payload, return it with
 * `predictiveInsight` guaranteed present (computed here when the upstream
 * omitted it) so the response matches the legacy monolith shape exactly.
 */
export function ensurePredictiveInsight(sentimentPayload) {
  if (!sentimentPayload || typeof sentimentPayload !== 'object') return sentimentPayload;
  if (sentimentPayload.predictiveInsight) return sentimentPayload;
  return {
    ...sentimentPayload,
    predictiveInsight: generatePredictions(
      sentimentPayload.symbol || '',
      sentimentPayload.overallScore || 0,
      sentimentPayload.news || []
    ),
  };
}
