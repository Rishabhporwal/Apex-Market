import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Tradexa AI | Institutional-Grade Stock Market Intelligence',
  description: 'Advanced stock market research platform with real-time analytics, AI sentiment prediction, interactive charting, financial modeling, SEC filings, stock screener, quantitative backtesting and simulated paper trading.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="min-h-screen bg-[#f7f7f8] text-[#0a0b0d] antialiased selection:bg-blue-100 selection:text-blue-900">
        {children}
      </body>
    </html>
  );
}
