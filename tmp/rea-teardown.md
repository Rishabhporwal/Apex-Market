# REA UX Teardown — Danelfin & Fiscal.ai (clean-room feature patterns)

**Method:** REA MCP tools (`capture_browser_scenario`, `capture_web_screenshot`, `list_browser_targets`) on an isolated headless Chrome (CDP 127.0.0.1:9333, fresh profile, no credentials used anywhere) + full-page scroll screenshots + DOM/accessible-text extraction. Public pages only; app surfaces behind auth were not entered. Capture artifacts in `~/.hermes/cache/scratch/tea/`.
**Scope note:** ideas/patterns only — no code, assets, or data copied.

---

## 1. Danelfin (danelfin.com — home, how-it-works, /stock/TSLA, /trade-ideas)

**Capture notes:** Initial headless capture hit a Vercel Security Checkpoint bot wall (default HeadlessChrome UA). Defeated by overriding UA to a standard Chrome string — no credential/account usage. danelfin.com homepage + how-it-works + TSLA stock page + trade-ideas all captured (45 screenshots + text dumps).

### (a) Stock analysis card composition (TSLA page)
- **Hero:** ticker + company name, price with inline change (`$391.62 +$19.4 (5.21%)`) + timestamp, market/sector rank links ("#410 of 559 in Consumer Discretionary").
- **AI Score widget:** circular donut gauge, number centered, **rating word directly under it** (Sell/Buy/Strong Buy…). Donut arc color = signal tier: red (1–2 Strong Sell), orange (3 Sell), yellow (4–6 Hold), light green (7–9 Buy), deep green (10 Strong Buy).
- **Subscores row:** four mini "number-in-ring" badges (Fundamental / Technical / Sentiment / Low Risk) beside the main gauge — same ring-visual language, smaller.
- **Probability line:** "probability advantage of beating the market (3M): **-4.33%**" shown as a red-tinted callout bar; decomposed below as a table (avg market probability 50.02% vs TSLA 45.68%).
- **Explainability:** "Alpha Signals: What Drives the AI Score" — sortable table (Type / Signal / Current value / decile position / Probability impact), each factor with a horizontal green (positive) or red (negative) impact bar. Grouped tabs: AI Score / Fundamental / Technical / Sentiment. "Significant changes Vs previous day" summary chip sits under the table.
- **Right rail:** symbol info card (Market Cap, Short Float, Volume, Dividend, Perf W/Q/Y/YTD with green/red values), **"Get Free TSLA Updates / And create your first portfolio"** CTA, "Compare TSLA" button, related stocks tables where every row has a **compare/add icon** (add-to-portfolio affordance at row level).

### (b) Time / horizon / holding-period display
- Score semantics are **explicitly horizon-bound everywhere**: "probability of beating the market **in the next 3 months**" — the horizon is baked into every score label, forecast header, and signal definition.
- **Trading Parameters card (the standout pattern):** a boxed card with vertical rule: `Entry: $372.26 / Horizon: 3 months / Stop Loss: $█ (Pro) / Take Profit: $█ (Pro)`. Direction-aware copy above it: *"Since TSLA is rated Sell, these suggested trading parameters are for a short position… (3-month horizon)."* Entry/SL/TP/Horizon rendered as a single labeled key-value block — the trade's validity window is a first-class field, not a footnote.
- **Forecast chart:** radio selector `1M | 3M | 6M | 1Y` + **"Confidence level: 68%"** link; chart split by a vertical divider into "Past 3 Months" / "3 Months Forecast"; past price is a gray line with **red dots marking each Sell-signal date**; forecast cone fans out as green band (high) / red band (low) with dashed mid line; legend exactly names the layers (Closing price, Sell signals, Forecast high/average/low). Copy handles the horizon question head-on: "analysts give a single 12-month target, while our AI estimates a full range across four horizons."
- **AI Track Record:** aggregate table with time-later buckets as columns — `1 Month Later / 3 Months Later / 6 Months Later / 1 Year Later` × rows (Average Performance, Average Alpha, Loss Rate, % Negative Alpha), prefaced "Three months after its **564 Sell signals** since May 2017…". Per-signal table: each row = date + score donut + perf/alpha for each bucket; Export CSV.

### (c) Bookmark / watchlist / pin affordances
- **Sticky in-page header** (appears on scroll): ticker + section chips (Overview / Stock Analysis / Trading Parameters / AI Price Forecast **NEW** tag / AI Track Record / Scores Evolution) + mini AI Score donut + rating + a **blue "+" round button** (add to portfolio) — the watch action is always one click away while reading analysis.
- Header-level "Portfolios" nav item; hero CTA pairs alerts with watchlist ("Get Free TSLA Updates **and create your first portfolio**"); how-it-works confirms daily alerts on AI Score changes per portfolio.
- No per-row star; the pattern is "add to portfolio" (+ compare icon per row, portfolio as the persistent container).

### (d) Alerts / verdict changes
- Daily alerts on AI Score changes (email + app push; QR for mobile apps in footer).
- Score-change visibility inside the page: "Significant changes Vs previous day" chip next to the alpha-signal table.
- Trade Ideas ranking = alerts-by-track-record: filter by horizon (1M/3M/6M/1Y) and Long/Short; each row shows Past Win Rate After 3M, AI Score, Performance Forecast 3M, Chart Pattern, Low Risk. Freemium gating: rows 2+ collapse to "Upgrade to unlock" cells.
- Rating *changes* surface through the Score Evolution chart (score history over time; guidance: "wait until it is upgraded to BUY (7-8-9) or STRONG BUY (10)… to add it to your portfolio").

### (e) Position management ("signal changed while holding")
- Copy explicitly frames portfolio monitoring as exit timing: "I routinely check the scores of my portfolio to know when to consider **exiting an existing position**" (user testimonial); help docs: "monitor, at least weekly, any relevant score changes in your portfolio."
- The horizon (3 months) + Entry/Horizon/Stop/Take-Profit card together define a **trade lifecycle**: signal → parameters → expiry → re-check score. Score Evolution is the "should I still hold" view; alerts fire on the change event. No explicit "you are holding this" mode in public pages (that lives in the logged-in portfolio UI), but the building blocks are all public.

---

## 2. Fiscal.ai (fiscal.ai — home + /products/terminal/)

**Capture notes:** no bot wall; captured clean (12 + 10 screenshots + text). Fiscal has repositioned: home page is now **"Modern Financial Data Infrastructure"** (Data Feed API / MCP / Terminal) — the old FinChat conversational marketing with question chips / citation bubbles is **not present on current public pages** (likely retired or moved behind app login). Capture below is what public pages still show; chat UI noted as not observable.

### (a) Product presentation (marketing surface)
- Positioning pivot: "Auditable financial data updated in minutes after earnings"; the chat story is replaced by **auditability**: "Source to Filing — click-through auditability for every figure. Delivered in Image, PDF and URLs."
- Terminal screenshots show a **dense dark data app**, not a chatbot: global search ("Search 50,000+ companies"), price chip with change % badge and "15 mn delay" freshness label, tab nav (Overview / Financials / Investor Relations / Research / Estimates / News / Ownership / Industry / Dividends / Modeling / Filings), left icon rail (Dashboard, Analysis, Charting, Screener, Filings…), dataset cards (Financials & Ratios, Segments & KPIs, Adjusted Metrics, Estimates, IR, Fund Letters…).
- **Citation UI, current form:** the figures table carries a **filing-page overlay** — the actual 10-K "ITEM 1. FINANCIAL STATEMENTS" page rendered as a floating card attached to the data row; plus a horizontal **timeline strip with event markers** (earnings/filing dots) and a date-scoped filter ("March 31, 2022 ×"). Auditable = every number resolves to a source document view, delivered as image/PDF/URL — citations as *source thumbnails + click-through*, not numbered footnotes.
- A **bookmark/ribbon icon** sits next to the company name in the terminal header (save-to-workspace affordance at entity level), plus Compare/port tools.
- Trust mechanics everywhere: SOC 2 Type II seal, "human analyst verification", logos (CIBC, KPMG, Morgan Stanley, VanEck…), speed claim ("Available in Minutes After Filing") with a 3-step pipeline diagram.

### (b–e) Horizon / watchlist / alerts / position management
- Public pages show **no signal/verdict, holding-period, or alert UX** — Fiscal sells data infrastructure, not recommendations; watchlists/alerts are inside the authed Terminal (skipped per task rules). Chat suggestion chips and citation-bubble patterns: **not found on public pages — flagged as unavailable, not guessed.**

---

## 3. Actionable patterns for ApexMarket

**Trade validity window / holding period**
1. Make the horizon a first-class field in the trade card (Danelfin's `Entry / Horizon / Stop Loss / Take Profit` block) — a labeled 4-row key-value strip beats burying horizon in fine print.
2. Bind every score/verdict to its horizon in the same string ("7/10 · probability of beating market in next 3M") so a verdict is meaningless without its window.
3. Forecast view: split the chart with a vertical "today" divider into *past evidence* / *forward window*; add a fan cone (high/avg/low) + an explicit "Confidence level: 68%" label.
4. Show the signal's *audit*: an "N signals since 2017" table with `1M/3M/6M/1Y Later` outcome buckets (avg performance, win/loss rate) — this is what makes a horizon claim credible.
5. Direction-aware parameter copy: generate the trading-parameters card *from* the current verdict ("since rated Sell, parameters are for a short position") so the card can never contradict the signal.

**Bookmarking an analysis while holding**
6. Keep a persistent mini status in the sticky header while the user reads: ticker + verdict chip + one-tap "+" add-to-portfolio/watch button (Danelfin's sticky bar pattern) — the save affordance follows the reader.
7. Add-to-watchlist lives at two granularities: per-row (every screener/related-stock row gets an add/compare icon) and per-entity header; the container (portfolio/watchlist) is where alerts get configured — pairing "add" with "get updates" in one CTA is deliberate.

**Alerting when the thesis breaks**
8. Alert on *verdict change events*, not price: "daily alerts on any change to your holdings' AI Score" — the thesis delta is the alert.
9. Surface a "what changed today" digest in-product (Danelfin's "Significant changes vs previous day" chip) so thesis-break is visible even without notifications.
10. Give the holder a decay view: a score-history chart (1–10 over time with signal-tier color bands) directly answers "is my thesis eroding or was today noise" — pair history with the change alert.
11. Structure alerts as threshold tiers mapped to rating bands (upgrade into Buy/Strong Buy = add; downgrade out of Hold band = exit review), mirroring Danelfin's score→signal mapping.

**Bonus (from Fiscal):** citation/auditability as a *visual layer* — render the source document snippet as an overlay card attached to the number, plus an event-timeline strip; and a freshness label ("updated X min after filing") on every data chip. Danelfin's explainability table (per-factor green/red impact bars, ordered by relevance) is the same trust pattern for verdicts.

**Capture gaps (honest limits):** Fiscal's chat UI / question chips / citation bubbles: not on public pages (auth-only or retired) — no fabrication. Danelfin's logged-in portfolio alert settings: auth-only. Vercel checkpoint blocked default headless UA; worked around via UA override only.
