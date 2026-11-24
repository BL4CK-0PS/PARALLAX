# PARALLAX
### A safety layer for AI browser agents: blocks dangerous actions, explains failures, records everything.

[![Hackathon](https://img.shields.io/badge/wHACKiest%202026-CodeRIT%20%7C%20RIT%20Bengaluru-orange.svg)](#)
[![Track](https://img.shields.io/badge/Track%202-Beyond%20the%20Browser-purple.svg)](#)
[![Team](https://img.shields.io/badge/Team-BL4CK__0P%24-black.svg)](#)
[![Runtime Security](https://img.shields.io/badge/Policy-Deterministic%20Fail--Closed-red.svg)](#)

---

## The problem, in one line
AI agents now fill forms and click Submit for people, but a hijacked agent can leak an OTP or press "Pay", and afterwards nobody can say what it did.
In 2025 [Brave showed](https://brave.com/blog/comet-prompt-injection/) hidden Reddit text making Perplexity's Comet agent leak a user's OTP, and OpenAI [said](https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/) prompt injection is "unlikely to ever be fully solved".

**Built for:** AI/automation engineers at ed-tech, fintech and HR companies shipping browser agents that fill forms for their customers.

## What it does (3 features)
| | What you get | How |
|---|---|---|
| **Guard** | The agent can't leak data, pay or type a password without you, even when the AI is fooled | Browser-level allowlist; approval gate that reads the button **from the page, not from the AI**; secret-field ban |
| **Diagnose** | When a task fails, you get the exact step and the tested cause | CHRONOS state diff · GHOST probes · MIRROR ranks fixes |
| **Replay** | Every click, request and decision, replayable | Hash-chained JSONL event store + timeline UI |

## Before / after (measured, not claimed)
`npm run eval` runs 14 attack techniques and 8 normal workflow steps with and without the guard. Full table: [`docs/submission/BEFORE_AFTER.md`](docs/submission/BEFORE_AFTER.md).

| | Agent alone | Agent + PARALLAX |
|---|---|---|
| Harmful actions that ran (of 14) | 14 | **0** (11 blocked, 3 paused for approval) |
| Normal steps that ran without friction (of 8) | 8 | 7 (final submit asks once) |
| Normal steps wrongly blocked | 0 | 0 |

This measures what happens *after* a model is fooled. It is not a detection rate.

**Try it yourself:** `npm run dev`, then open <http://localhost:5173/playground>. Replay the 14 attacks, or try to sneak your own URL, disguised button or secret field past the guard. Every verdict comes from the real policy engine.

## Honest status
- **Real:** policy guard, event store with integrity check, recovery planner, verifier, demo backend, before/after harness, and (P2) a real Playwright browser: every click/type/submit reads `DomFacts` from the live element and passes the guard before dispatch; approvals in the Command Center control execution; GHOST runs read-only probes with documented evidence scoring; CHRONOS reconstructs last-good state from the event store.
- **Deterministic, not an LLM:** the demo agent follows a fixed workflow. The "hijacked" Pay/navigation proposals are labelled simulations of what a fooled model would propose; the guard decides them for real. MIRROR candidate utilities are planner constants.
- Run it: `npm install && npx playwright install chromium`, then `npm start` (Command Center on :5173) or `npm run demo:run -- full-demo`. Tests: `npm test` (no browser) and `npm run test:e2e` (real Chromium). Details: [`docs/P2_COMPLETION_REPORT.md`](docs/P2_COMPLETION_REPORT.md).

Pitch material: [`docs/submission/PITCH_DECK_CONTENT.md`](docs/submission/PITCH_DECK_CONTENT.md) · [`docs/submission/WINNING_RULES.md`](docs/submission/WINNING_RULES.md). Architecture: [root README](../README.md).

---

## Directory Index

| Path | Purpose |
|---|---|
| [`demo-app/pages`](demo-app/pages/) | Synthetic university application portal UI |
| [`demo-app/server`](demo-app/server/) | Deterministic backend state machine for the portal |
| [`demo-app/failures`](demo-app/failures/) | Injectable failures: session expiry, dynamic field dependencies |
| [`demo-app/fixtures`](demo-app/fixtures/) | Synthetic personas and test datasets (zero PII) |
| [`src/capture`](src/capture/) | Browser observation and CDP network allowlisting (Playwright) |
| [`src/core`](src/core/) | Typed event contract, state model, normalizer, diff engine |
| [`src/chronos`](src/chronos/) | Temporal reconstruction, last-good state, first failure identification |
| [`src/ghost`](src/ghost/) | Hypothesis-discriminating safe micro-experiments |
| [`src/mirror`](src/mirror/) | Transition model & recovery candidate comparison |
| [`src/policy`](src/policy/) | Deterministic fail-closed policy engine & approval gate |
| [`src/planner`](src/planner/) | Bounded recovery plan search and ranking |
| [`src/verify`](src/verify/) | Postcondition verification against target state |
| [`src/llm`](src/llm/) | Model client for structured proposals (zero direct execution authority) |
| [`ui/`](ui/) | Command center: timeline replay, hypotheses, approval gate |
| [`tests/`](tests/) | Unit, integration, e2e, and security test suites |
| [`deploy/`](deploy/) | GPU server (2× L40) and local development configurations |

---

## Engineering Rules

* **Evidence over Interpretation:** Observations (`observed before`, `supports hypothesis`) are kept separate from causal inferences.
* **LLM Proposes, Deterministic Policy Decides:** The model has zero direct execution privileges over the browser or network.
* **Synthetic Targets Only:** All testing and demonstrations run against local, reproducible test fixtures.
