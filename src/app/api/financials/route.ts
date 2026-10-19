import { NextRequest, NextResponse } from 'next/server';
import { financialsService } from '@/services/financialsService';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // Microservice mesh first (when configured); local implementation otherwise
  const proxied = await proxyToGateway(req, '/api/financials');
  if (proxied) return proxied;

  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'NVDA';
    const section = searchParams.get('section') || 'all';

    if (section === 'overview') {
      const overview = await financialsService.getCompanyOverview(symbol);
      return NextResponse.json(overview);
    }

    if (section === 'key-metrics') {
      const metrics = await financialsService.getKeyFinancials(symbol);
      return NextResponse.json(metrics);
    }

    if (section === 'statements') {
      const statements = await financialsService.getFinancialStatements(symbol);
      return NextResponse.json(statements);
    }

    // Default 'all': return combined financial payload
    const [overview, metrics, statements] = await Promise.all([
      financialsService.getCompanyOverview(symbol),
      financialsService.getKeyFinancials(symbol),
      financialsService.getFinancialStatements(symbol),
    ]);

    return NextResponse.json({
      overview,
      metrics,
      statements,
    });
  } catch (error: any) {
    console.error('Financials API error:', error);
    return NextResponse.json({ error: error.message || 'Financials service failed' }, { status: 500 });
  }
}
