# wHACKiest 2026: Pitch Content (source of truth for the deck and the video)
### Team BL4CK_0P$ · Track 2: Beyond the Browser · Team ID 7e709e42
### Deck file: `BL4CK_0P_Track2.pptx` (official 8-slide template, no extra slides)

> Every number here must be sourced (linked) or measured by us (`npm run eval`).
> If a claim has neither, it does not go on a slide. See `WINNING_RULES.md`.

---

## One-line pitch (no jargon)
**PARALLAX is a safety layer for AI browser agents: it blocks dangerous actions, explains failures and records everything.**

## Who we build for (one persona, not "everyone")
- **Buyer / user:** AI and automation engineers at ed-tech, fintech and HR companies shipping browser agents that fill forms for customers. They take the blame when the agent misbehaves.
- **People protected:** the students and applicants whose forms, OTPs and fees the agent handles.

---

### Slide 1: Title
Team BL4CK_0P$ · Sri Ramakrishna Engineering College, Coimbatore · Track 2 · Team ID 7e709e42
Members: Kishanth R (Lead), Dharshan S. USNs: **TODO, fill in your college register numbers.**

### Slide 2: Problem
- One line: an AI agent acting on untrusted web pages has full power and no flight recorder.
- Three pains: **hijackable** (hidden text makes it leak data or press Pay), **fragile** (expired login or hidden field breaks the flow), **unauditable** (no root cause, no proof the fix worked).
- Evidence (all verified):
  - Brave, Aug 2025: hidden text in a Reddit comment made Perplexity's Comet agent leak a user's OTP. <https://brave.com/blog/comet-prompt-injection/>
  - OpenAI, Dec 2025: prompt injection is "unlikely to ever be fully solved". <https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/>
  - Gartner, Jun 2025: 40%+ of agentic AI projects will be scrapped by 2027; inadequate risk controls are one of three named causes (forecast, not observed). <https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027>
- Icebreaker to open the pitch: *"Raise your hand if you'd let an AI agent fill your scholarship form and press Submit with your bank details."*

### Slide 3: Solution (3 features, plain words)
| Feature | What the user gets | Under the hood |
|---|---|---|
| **Guard** | Can't leak data, pay or type your password without you, enforced by the browser, not the AI | Policy engine: allowlist + DOM-grounded approval gate + secret-field ban |
| **Diagnose** | When a task fails, finds the exact step and tests why | CHRONOS (state diff) · GHOST (probes) · MIRROR (rank fixes) |
| **Replay** | Every click, request and decision recorded | Hash-chained JSONL event store + timeline UI |

Demo order (core feature first): injection blocked → Final Submit waits for approval → session expiry diagnosed → replay.

### Slide 4: Tech stack
Playwright + Chromium · Node.js 22+ with native TypeScript type-stripping · open-weights model on vLLM (2× L40S, proposals only) · append-only JSONL + SHA-256 · HTML/JS dashboard · `node:test`.
Don't put version numbers on the slide unless that version is actually installed.

### Slide 5: Architecture
INPUT (portal → Playwright → allowlist → event store) → PROCESS (CHRONOS → GHOST → LLM → MIRROR) → OUTPUT (policy engine → human gate → executor → verifier → timeline).
Key line: "The LLM proposes; deterministic code disposes; every step is logged."

### Slide 6: Novelty
- Capabilities, not detection: safety holds even when the model is fooled.
- The approval gate reads the button from the page, not from the AI (a fooled agent can call "Pay" "View details"; our guard still sees "Pay").
- DFIR-style timeline reconstruction applied to agents.

### Slide 7: Before / after (measured: `npm run eval`, see `BEFORE_AFTER.md`)
| | Agent alone | Agent + PARALLAX |
|---|---|---|
| Harmful actions that ran (of 14 attack techniques) | 14 | **0** (11 blocked, 3 paused for approval) |
| Normal workflow steps that ran freely (of 8) | 8 | 7 (final submit asks once) |
| Normal steps wrongly blocked | 0 | 0 |

Say exactly this, no stronger: *"Once the model is fooled, none of our 14 attack techniques gets through."* It is **not** a detection rate.
Our own guard, as committed before the DOM-grounding fix, let 6 of 14 through; the harness caught it. That's a good Q&A story.

### Slide 8: Business model
Open-core: free guard SDK → Pro (hosted timeline, retention, per seat) → Enterprise (on-prem, compliance reports, per agent). Go-to-market: open-source on GitHub/npm, plug-ins for Playwright / Browser Use, pilots with campus IT and admission portals.

---

## Q&A prep (answer honestly; judges punish overclaiming)
- **"ChatGPT Agent already asks before buying."** Yes, but the AI decides when to ask. Ours is decided by code from the page itself, so a fooled AI cannot skip it.
- **"Isn't this just a firewall?"** A firewall can't tell a Pay button from a FAQ button, explain why a task failed, or prove the fix worked.
- **"How good is GHOST?"** Honest answer: in the MVP it matches error patterns to 3 known failure types; real probing is limited to session checks. The next step is information-gain probe selection.
- **"What isn't built yet?"** Say it plainly: MIRROR simulation is basic, and the agent loop in the demo is scripted around a real policy engine and backend.
- **"Your keyword list will miss things."** True, which is why a click with no DOM facts fails closed (asks the user) instead of passing.
