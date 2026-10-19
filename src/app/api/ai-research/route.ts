import { NextRequest, NextResponse } from 'next/server';
import { llmService } from '@/services/llmService';
import { marketDataService } from '@/services/marketDataService';
import { technicalService } from '@/services/technicalService';
import { sentimentService } from '@/services/sentimentService';
import { financialsService } from '@/services/financialsService';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // Microservice mesh first (when configured); local implementation otherwise
  const proxied = await proxyToGateway(req, '/api/ai-research');
  if (proxied) return proxied;

  try {
    const body = await req.json();
    const symbol = (body.symbol || 'NVDA').toUpperCase();
    const customApiKey = body.apiKey;
    const provider = body.provider || 'auto';

    // Gather context concurrently
    const [quote, candles, sentiment, keyFin] = await Promise.all([
      marketDataService.getQuote(symbol),
      marketDataService.getHistoricalCandles(symbol, '1y', '1d'),
      sentimentService.analyzeStockSentiment(symbol),
      financialsService.getKeyFinancials(symbol).catch(() => null),
    ]);

    const technicalSummary = technicalService.getTechnicalSummary(symbol, candles);

    const result = await llmService.runDeepAnalysis(
      {
        symbol,
        companyName: quote.name,
        currentPrice: quote.price,
        technicalSummary,
        sentimentScore: sentiment.overallScore,
        newsHeadlines: sentiment.news.map((n) => n.title),
        keyFinancials: keyFin,
        userQuery: body.query,
      },
      customApiKey,
      provider
    );

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('AI Research API error:', err);
    return NextResponse.json({ error: err.message || 'AI Research service failed' }, { status: 500 });
  }
}
