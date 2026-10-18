import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ApexMarket AI | Institutional-Grade Stock Market Intelligence',
  description: 'Advanced stock market research platform with real-time analytics, AI sentiment prediction, interactive charting, financial modeling, SEC filings, stock screener, quantitative backtesting and simulated paper trading.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#070b12] text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
