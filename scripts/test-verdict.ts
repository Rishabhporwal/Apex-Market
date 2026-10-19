import { aiVerdictService } from '../src/services/aiVerdictService';

async function main() {
  for (const symbol of ['AAPL', 'NVDA']) {
    const verdict = await aiVerdictService.generateVerdict(symbol);
    console.log(`\n===== ${symbol} =====`);
    console.log(JSON.stringify(verdict, null, 2));
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
