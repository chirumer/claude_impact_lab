# RestoLine

A phone-style Messages app (Electron) with an AI assistant contact — **RestoLine** — powered by Claude. Built for a hackathon.

<p>
  <img src="https://img.shields.io/badge/Electron-390x844-47848F" alt="Electron">
  <img src="https://img.shields.io/badge/Chat-claude--haiku--4--5-D97757" alt="Claude Haiku 4.5">
  <img src="https://img.shields.io/badge/Embeddings-voyage--4--lite-6E56CF" alt="Voyage AI">
</p>

## What it does

- Opens a native, phone-sized window (390×844) styled like iOS Messages — status bar, contact list, chat thread, bubbles.
- **RestoLine** is the one contact in the list. It's a Claude-powered chat assistant that sends and receives real messages.
- **Give feedback by replying.** Swipe/tap the reply icon on any RestoLine message to send free-text feedback (a correction, a thumbs-up, etc.). Claude analyzes the feedback and decides:
  - sentiment (positive / negative / neutral)
  - whether there's a factual correction to remember
  - whether RestoLine needs to ask a clarifying follow-up before the feedback is actionable
  - whether this *type* of question needs live web search to answer correctly
- **Shared learning across users.** A small persona switcher (You / Alex / Sam) simulates multiple people texting RestoLine. Every new question is embedded and compared against past questions **that already have feedback attached**, from any persona. Similar matches (cosine similarity above a threshold) get folded into the prompt as context — including corrections other users gave and whether the question needs web search — before Claude answers. The UI surfaces this transparently with small captions under RestoLine's replies (e.g. *"Informed by 2 similar past questions"*, *"🔎 Searched the web"*).
- Ships with a few seeded historical Q&A exchanges (with feedback already attached) so the shared-learning feature has something to match against on first launch.

## Stack

| Piece | Choice |
|---|---|
| Desktop shell | Electron (no bundler — plain HTML/CSS/JS renderer) |
| Chat model | [`claude-haiku-4-5`](https://console.anthropic.com) via `@anthropic-ai/sdk` |
| Feedback analysis | Same model, using Claude's structured outputs (`output_config.format`) for reliable JSON |
| Web search | Claude's server-side `web_search` tool, auto-enabled when a matched past question was flagged as needing it |
| Embeddings | [Voyage AI](https://voyageai.com) `voyage-4-lite` (Anthropic has no embeddings API — Voyage is their documented recommendation) via a plain `fetch` call |
| Data store | A single JSON file (`data/app.json`) — no database, no native deps |

If embeddings are unavailable (no Voyage key configured, network error, etc.), RestoLine still answers — it just skips the cross-user context for that reply instead of failing.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...      # https://console.anthropic.com/settings/keys
VOYAGEAI_API_KEY=...              # https://dashboard.voyageai.com (free tier available)
```

Run it:

```bash
npm start
```

## Project layout

```
main.js              Electron main process + IPC handlers
preload.js            contextBridge API exposed to the renderer
src/
  store.js            JSON-file datastore (personas, messages, qaRecords, feedback) + seed data
  ai.js                Claude chat/structured-output calls + Voyage embedding calls
  similarity.js        Cosine similarity search over feedback-tagged past questions
  chatFlow.js          Orchestrates: embed → find similar → build context → generate reply
renderer/
  index.html, styles.css, app.js   The Messages-style UI
data/app.json          Local datastore (gitignored)
```

## How the feedback → context loop works

1. A user asks RestoLine a question. It's embedded and compared against past questions that already have feedback attached (from any persona).
2. Claude answers, optionally informed by those matches and the corrections they carry.
3. The user can reply to that answer with feedback. Claude analyzes it and may:
   - store a correction for future matches on similar questions,
   - flag the question type as needing live web search going forward,
   - or ask a clarifying follow-up right in the thread (the user's next message answers it, and RestoLine sends a refined final answer).
