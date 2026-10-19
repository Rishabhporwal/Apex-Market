import { NextRequest, NextResponse } from 'next/server';
import { screenerService, PRESETS } from '@/services/screenerService';
import { proxyToGateway } from '@/services/gatewayProxy';
import { ScreenerFilter } from '@/types';

export const runtime = 'nodejs';

// GET /api/screener — presets, search/autocomplete, full filters
export async function GET(req: NextRequest) {
  // Microservice mesh first (when configured); local implementation otherwise
  const proxied = await proxyToGateway(req, '/api/screener');
  if (proxied) return proxied;

  try {
    const { searchParams } = new URL(req.url);

    // Return preset definitions for the UI
    if (searchParams.get('presets') === '1') {
      return NextResponse.json({ presets: PRESETS });
    }

    // Autocomplete search (name/ticker)
    const searchQuery = searchParams.get('search')?.trim();
    if (searchQuery) {
      const { edgarService } = await import('@/services/edgarService');
      const results = await edgarService.searchCompanies(searchQuery, Number(searchParams.get('limit') ?? 10));
      return NextResponse.json(results);
    }

    // Preset-based screen (e.g. ?preset=quality)
    const presetId = searchParams.get('preset')?.trim();
    if (presetId) {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (preset) {
        const results = await screenerService.screenStocks(preset.filters);
        return NextResponse.json(results);
      }
      return NextResponse.json({ error: `Unknown preset: ${presetId}` }, { status: 400 });
    }

    // Full filter query (GET style)
    const sector = searchParams.get('sector') || undefined;
    const minPe = searchParams.get('maxPe') ? Number(searchParams.get('maxPe')) : undefined;
    const minRevenueGrowth = searchParams.get('minRevenueGrowth') ? Number(searchParams.get('minRevenueGrowth')) : undefined;
    const minNetMargin = searchParams.get('minNetMargin') ? Number(searchParams.get('minNetMargin')) : undefined;
    const minRoe = searchParams.get('minRoe') ? Number(searchParams.get('minRoe')) : undefined;

    const results = await screenerService.screenStocks({
      sector,
      maxPE: minPe,
      minRevenueGrowth,
      minNetMargin,
      minRoe,
    });
    return NextResponse.json(results);
  } catch (error: any) {
    console.error('[api/screener] GET error:', error);
    return NextResponse.json({ error: error.message || 'Screener service failed' }, { status: 500 });
  }
}

// POST /api/screener — full filter body
export async function POST(req: NextRequest) {
  const proxied = await proxyToGateway(req, '/api/screener');
  if (proxied) return proxied;

  try {
    const filters: ScreenerFilter = await req.json();
    const results = await screenerService.screenStocks(filters);
    return NextResponse.json(results);
  } catch (error: any) {
    console.error('[api/screener] POST error:', error);
    return NextResponse.json({ error: error.message || 'Screener service failed' }, { status: 500 });
  }
}
