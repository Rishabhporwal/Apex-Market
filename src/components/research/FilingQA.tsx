'use client';

import React, { useState } from 'react';
import { MessageSquare, FileText, ExternalLink, Loader2, AlertTriangle } from 'lucide-react';

interface FilingQAResult {
  symbol: string;
  question: string;
  answer: string;
  sources: { n: number; section: string | null; url: string; excerpt: string }[];
  filing: { form: string; filedAt: string; url: string };
}

const EXAMPLES = [
  'What are the main risk factors?',
  'How does the company describe its competition?',
  'What does the company say about supply chain?',
  'Summarize the key accounting policies.',
];

/** Ask-the-filings panel: grounded Q&A over the company's actual SEC filing,
 *  with numbered citations. Served by svc-research (retrieval) + svc-llm (answer). */
export function FilingQA({ symbol }: { symbol: string }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FilingQAResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/filing-qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch {
      setError('Could not reach the filing service');
    } finally {
      setBusy(false);
    }
  };

  // Render the answer with light markdown: headings, bold, [n] citations highlighted
  function renderAnswer(text: string) {
    return text.split('\n').map((line, i) => {
      const t = line.trim();
      if (!t) return <div key={i} className="h-1.5" />;
      if (/^#{1,4}\s/.test(t)) {
        return <div key={i} className="font-bold text-slate-900 pt-2">{t.replace(/^#{1,4}\s*/, '')}</div>;
      }
      if (/^[-*]\s/.test(t)) {
        return (
          <div key={i} className="flex gap-2 ml-2">
            <span className="text-muted shrink-0">•</span>
            <span className="text-muted">{renderInline(t.slice(2))}</span>
          </div>
        );
      }
      return <p key={i} className="text-muted">{renderInline(t)}</p>;
    });
  }

  function renderInline(text: string): React.ReactNode[] {
    // Highlight [1] style citations and **bold**
    const parts = text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p, i) => {
      if (/^\[\d+\]$/.test(p)) {
        const n = Number(p.slice(1, -1));
        return (
          <span key={i} className="inline-flex items-center justify-center bg-blue-50 text-accent rounded px-1 mx-0.5 text-xs font-bold align-middle">
            {n}
          </span>
        );
      }
      if (p.startsWith('**') && p.endsWith('**')) {
        return <strong key={i} className="text-slate-900 font-semibold">{p.slice(2, -2)}</strong>;
      }
      return <span key={i}>{p}</span>;
    });
  }

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-1">
        <MessageSquare className="h-4 w-4 text-slate-500" /> Ask the filings
      </h3>
      <p className="text-xs text-muted mb-4">
        Answers come only from {symbol}'s actual SEC filing text, with citations to the excerpt each claim came from. No outside knowledge.
      </p>

      <div className="flex gap-2 flex-wrap mb-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => ask(ex)}
            disabled={busy}
            className="px-2.5 py-1 rounded-full border border-slate-300 text-xs text-muted hover:border-accent/40 hover:text-accent transition disabled:opacity-40"
          >
            {ex}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(question)}
          placeholder={`Ask anything about ${symbol}'s filing — e.g. "What are the main risks?"`}
          className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-muted focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => ask(question)}
          disabled={busy || !question.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent border border-accent text-white text-sm font-semibold hover:bg-accent-hover transition disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
          {busy ? 'Reading the filing…' : 'Ask'}
        </button>
      </div>

      {busy && (
        <div className="mt-4 text-xs text-muted flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Fetching the filing from SEC EDGAR, splitting it into sections, and answering from the relevant parts — can take up to a minute on first ask.
        </div>
      )}

      {error && (
        <div className="mt-4 flex gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="mt-5">
          {result.filing && (
            <div className="text-xs text-muted mb-3 flex items-center gap-2 flex-wrap">
              <FileText className="h-3.5 w-3.5" />
              Grounded in {result.filing.form} filed {result.filing.filedAt ? new Date(result.filing.filedAt).toLocaleDateString() : ''} ·{' '}
              <a href={result.filing.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover underline inline-flex items-center gap-0.5">
                read the original <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          <div className="space-y-1 text-sm leading-relaxed bg-slate-50 rounded-xl p-4 border border-slate-200">
            {renderAnswer(result.answer)}
          </div>
          {result.sources?.length > 0 && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wider text-muted mb-2">Cited excerpts</div>
              <div className="space-y-2">
                {result.sources.map((s) => (
                  <div key={s.n} className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="inline-flex items-center justify-center bg-blue-50 text-accent rounded px-1.5 text-xs font-bold">[{s.n}]</span>
                      <span className="text-muted font-semibold">{s.section || 'Section'}</span>
                      <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:text-accent-hover inline-flex items-center gap-0.5">
                        source <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <p className="text-muted line-clamp-2">{s.excerpt}…</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
