# PARALLAX

Autonomous Digital Reality Intelligence. When a web task fails, find out why with evidence, test the cause, fix it only with approval, and prove it worked.

**Status:** structure only. No code, no dependencies, stack not final. Source of truth: `PARALLAX_Technical_Master_Specification.docx` (one level up).

## Layout

| Path | Purpose | Spec § |
|---|---|---|
| `demo-app/pages` | Synthetic university application portal (UI) | 2.3, 20.1 |
| `demo-app/server` | Deterministic backend state machine for the portal | 15.1, 20.1 |
| `demo-app/failures` | Injectable failures: session expiry, hidden field dependency, async validation | 11.4 |
| `demo-app/fixtures` | Synthetic users and data only. No real data. | 3.3 |
| `src/capture` | Browser observation and replay (Playwright) | 5.2 |
| `src/core` | Event contract, state model, normalizer, diff, store | 10, 19 |
| `src/chronos` | Timeline reconstruction, last-good state, first failure | 13 |
| `src/ghost` | Hypothesis-discriminating safe experiments | 11 |
| `src/mirror` | Transition model, recovery candidate comparison | 12 |
| `src/policy` | Allowlist, approval, invariants. Deterministic, fail closed. | 15.2, 16 |
| `src/planner` | Bounded recovery plan search and ranking | 14 |
| `src/verify` | Postcondition checks against the test backend | 15, 22.3 |
| `src/llm` | Model client and explanation. Has no execution authority. | 9 |
| `ui` | Command center: timeline, hypotheses, approval, audit report | 5.1 |
| `tests/{unit,integration,e2e,security}` | Layers per spec §22.1 | 22 |
| `scripts` | Run, seed, reset helpers | — |
| `data` | Run logs and evidence. Git-ignored. | 19.3 |
| `deploy` | Notes for the GPU server (L40 x2) | 18 |
| `docs/decisions` | Short decision records (stack, model, scope cuts) | — |
| `docs/submission` | PPT, video script, Devnovate checklist | — |

## Rules (from the spec)

- Raw evidence is separate from interpretation. Use "observed before / supports", not "caused".
- The LLM proposes; the policy engine decides. Page content is untrusted data.
- Every number shown in a demo comes from a recorded run. Label anything illustrative.
- Synthetic data and local or isolated targets only.
