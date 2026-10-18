'use client';

import React, { useState } from 'react';
import { 
  Bot, 
  Sparkles, 
  Key, 
  Send, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  Cpu, 
  ShieldCheck,
  RefreshCw
} from 'lucide-react';

interface AiCopilotModalProps {
  isOpen: boolean;
  onClose: () => void;
  symbol: string;
}

export function AiCopilotModal({ isOpen, onClose, symbol }: AiCopilotModalProps) {
  const [provider, setProvider] = useState<'gemini' | 'openai' | 'claude' | 'auto'>('auto');
  const [apiKey, setApiKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<any>(null);

  if (!isOpen) return null;

  const handleSaveKey = () => {
    if (apiKey.trim()) {
      localStorage.setItem('apex_ai_key', apiKey.trim());
      setSavedKey(true);
      setTimeout(() => setSavedKey(false), 2000);
    }
  };

  const handleRunAiResearch = async (customPrompt?: string) => {
    setLoading(true);
    setResponse(null);
    try {
      const storedKey = apiKey || localStorage.getItem('apex_ai_key') || '';
      const res = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          apiKey: storedKey || undefined,
          provider,
          query: customPrompt || query,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setResponse(data);
      }
    } catch (err) {
      console.error('AI Research Error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 font-sans">
      <div className="relative w-full max-w-3xl rounded-2xl border border-slate-700 bg-[#090e18] shadow-2xl p-6 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Glow */}
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-cyan-500/20 blur-3xl pointer-events-none" />

        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-600 text-white shadow-lg shadow-cyan-500/20">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white">AI Financial Analyst & Model Configuration</h3>
                <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-cyan-400 border border-cyan-500/20">
                  {symbol}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">Connect LLMs (Gemini, GPT-4o, Claude) or use native quantitative engine</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {/* Provider Selection */}
          <div className="space-y-2">
            <label className="text-xs font-mono font-semibold uppercase text-slate-400 flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-cyan-400" /> Select Intelligence Model
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
              {[
                { id: 'auto', label: 'Auto (Recommended)', desc: 'Best available engine' },
                { id: 'gemini', label: 'Google Gemini', desc: '1M+ token context (10-K)' },
                { id: 'openai', label: 'OpenAI GPT-4o', desc: 'Deep financial logic' },
                { id: 'claude', label: 'Claude 3.5 Sonnet', desc: 'Tabular statement audit' },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setProvider(m.id as any)}
                  className={`p-2.5 rounded-xl text-left border transition ${
                    provider === m.id
                      ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 shadow-sm'
                      : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <div className="font-bold text-white text-xs">{m.label}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* API Key Input */}
          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5 text-[11px] uppercase">
                <Key className="h-3.5 w-3.5 text-amber-400" /> Optional Custom LLM API Key (Stored Locally)
              </span>
              <span className="text-[10px] text-emerald-400">Works without key via local engine</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                placeholder="Paste Gemini API Key, OpenAI API Key (or leave blank to use free native AI)..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleSaveKey}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition font-bold"
              >
                {savedKey ? 'Saved!' : 'Save'}
              </button>
            </div>
          </div>

          {/* Quick Deep-Dive Prompt Chips */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-mono text-slate-400 uppercase">Quick Institutional Deep-Dives:</span>
            <div className="flex flex-wrap gap-1.5 font-mono text-xs">
              {[
                `Generate full institutional equity research thesis for ${symbol}`,
                `Analyze key risk factors and competitive headwinds for ${symbol}`,
                `Evaluate valuation multiple justification vs growth rate for ${symbol}`,
                `Synthesize latest earnings call conference transcript for ${symbol}`,
              ].map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setQuery(chip);
                    handleRunAiResearch(chip);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-cyan-500/20 hover:text-cyan-300 text-slate-300 border border-slate-700/60 text-[11px] transition text-left"
                >
                  ⚡ {chip}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Query Box */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder={`Ask AI financial analyst anything about ${symbol} (e.g. why did margin expand?)...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRunAiResearch()}
                className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white outline-none focus:border-cyan-500 font-mono"
              />
              <button
                onClick={() => handleRunAiResearch()}
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold font-mono text-xs transition disabled:opacity-50 shrink-0"
              >
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span>Analyze</span>
              </button>
            </div>
          </div>

          {/* AI Output Response View */}
          {response && (
            <div className="p-4 rounded-xl bg-slate-900/90 border border-cyan-500/30 space-y-3 font-sans">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 font-mono text-xs">
                <span className="flex items-center gap-1.5 text-cyan-400 font-bold">
                  <Sparkles className="h-4 w-4" /> Powered by {response.providerUsed} ({response.model})
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  response.analystToneAssessment === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-300'
                }`}>
                  Tone: {response.analystToneAssessment}
                </span>
              </div>

              <div className="text-xs text-slate-200 leading-relaxed whitespace-pre-line">
                {response.deepAnalysis}
              </div>

              {response.growthDrivers?.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80">
                  <div className="text-[11px] font-mono font-bold text-emerald-400 uppercase mb-1">
                    Key Growth Catalysts
                  </div>
                  <ul className="space-y-1 text-xs text-slate-300">
                    {response.growthDrivers.map((d: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-emerald-400 font-bold">•</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
