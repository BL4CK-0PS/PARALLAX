# P2 Implementation Audit (pre-implementation)

Date: 2026-11-23. Baseline commit: `592ad40`. Scope: Person 2 workstream
(`src/capture/`, `src/chronos/`, `src/ghost/`, `demo-app/pages|failures|fixtures/`, `ui/`)
and its integration with Person 1's modules.

## 0. Baseline measurements

| Check | Result |
|---|---|
| `npm test` | 45/45 pass (unit, security, integration). No test touches a browser. |
| `node_modules` | **Absent.** `package.json` declares no dependencies at all. Playwright is not installed. |
| TypeScript | No compiler installed. `tsc --noEmit` fails on every `.ts` import (TS5097) because `tsconfig.json` lacks `allowImportingTsExtensions`; with that flag, 0 errors. |
| Playwright browsers | `~/.cache/ms-playwright/chromium-1140` only (Playwright 1.48 era; no `ariaSnapshot`). |
| Node | v26.12.1 (`--experimental-strip-types` works; only erasable TS syntax is allowed). |

## 1. Existing implementations (what is really there)

| File | Owner | State |
|---|---|---|
| `src/core/types.ts` | P1 | Solid contracts. `Action.dom: DomFacts` exists and is what the guard trusts. |
| `src/core/store.ts` | P1 | Append-only, SHA-256 chained, JSONL per run in `data/runs/<runId>.jsonl`. |
| `src/policy/guard.ts` | P1 | Real deterministic guard: secret-field ban (selector + DOM facts), allowlist on navigate/href/formAction, approval gate from live DOM text, fail-closed CLICK without DOM facts. |
| `src/planner/recovery.ts` | P1 | Fixed candidate tables per `FailureCategory`; targets `textarea#statement_of_purpose`, `input#merit-scholarship`, `button#submit-application`. |
| `src/verify/verifier.ts` | P1 | Real postcondition check against `/api/admin/applications`. |
| `demo-app/server/server.ts` | P1 | Backend state machine with session flag and failure injection endpoints. |
| `src/eval/*`, `scripts/eval.ts` | P1 | Before/after benchmark; writes `data/eval/before-after.json`. |
| `ui/playground.ts|html` | shared | Working guard playground. |

## 2. P2 modules: missing / broken / fake

### `src/capture/browser.ts` — essentially missing
- Uses `any` for browser/page; `launch()` swallows every error and returns `false`.
- `captureSnapshot()` returns a **fabricated healthy snapshot** (`isHealthy: true`, hardcoded URL/title) when no page exists.
- Calls `page.ariaSnapshot()`, which does not exist in Playwright 1.48 and the error is swallowed.
- No network/console/navigation capture, no event-store integration, no redaction.
- **No action execution at all, so no `DomFacts` extraction and no guard-before-dispatch.** This is the main P1 dependency (`TASK_SPLIT.md`: "Without this, every click asks for approval").
- Builds its own private guard instance instead of sharing the run's guard/ledger.

### `src/ghost/prober.ts` — keyword matcher with invented confidence
- Hypotheses chosen by substring match on an error string; **hardcoded confidences 0.85 / 0.75 / 0.95 / 0.2**.
- Hypothesis H2 evidence is a fixed sentence, not observed evidence.
- `probeSessionStatus` exists but is never used by the UI flow; errors map to `false` ("expired"), i.e. a network error *confirms* H1.
- No INCONCLUSIVE outcome, no probe event recording, no DOM probe, no minimisation.

### `src/chronos/timeline.ts` — in-memory toy
- Does not read the event store; snapshots are pushed manually.
- Last-good state = latest snapshot with `isHealthy`, no failure-relative reasoning, no provenance, no state hash.
- Diff covers URL/inputs/session only; inputs diffed **unredacted**.
- `formatTimeline` stringifies raw payloads (secrets would leak).

### `ui/server.ts` — scripted theatre (critical)
- `executeAutonomousWorkflow()` is a sequence of `sleep()` calls and **hand-written events**: `DOM_OBSERVED` for pages never loaded, `ACTION_DISPATCHED` for typing that never happened, a 401 `FAILURE_DETECTED` dispatched without any request, `ACTION_DISPATCHED REAUTHENTICATE` without calling the refresh endpoint (it flips a server flag directly).
- No browser is launched. Approval resolves a promise but the "approved action" is a raw `fetch()` with a hardcoded body.
- `/api/approve` uses `Access-Control-Allow-Origin: *` and no origin check: any web page the operator visits can approve a pending action (CSRF).
- Events include the session token `SES_ACTIVE_98234` in a URL (`steal?cookie=SES_ACTIVE_98234`).
- `scripts/run-demo.ts` has the same fabricated flow and prints "Backend Response: 200 OK" without checking the status.

### `ui/index.html`
- Polls `/api/events` and renders the scripted data. Portal shown in an iframe (a different browser than the "agent", so it never shows agent state). No evidence inspector, no hypothesis evidence, no benchmark panel, no disconnected state.

### `demo-app/pages/index.html`
- 3 steps exist but no client validation; payload is plain visible text (no spoiler/reveal); no Pay button; no attestation checkbox; no session-expiry recovery path in the UI; SOP id `statement-of-purpose` **does not match P1 planner target** `textarea#statement_of_purpose`, so a planned recovery action could never resolve.
- `demo-app/failures/`, `demo-app/fixtures/`, `tests/e2e/`: empty (`.gitkeep`).

## 3. Integration problems

1. Guard ↔ browser: no code path passes a live `Action.dom` to `guard.evaluateAction` before a browser dispatch.
2. Planner ↔ page: selector mismatch above; `REAUTHENTICATE` has no concrete UI element.
3. Store chain is global across runs: `verifyIntegrity(runId)` fails for any run after the first in a shared store (first event of run 2 carries run 1's hash). P2 works around this by using one store per run (P1 code untouched).
4. Hypothesis contract has no `INCONCLUSIVE` status, which the P2 spec requires.
5. `EventType` has no type for browser navigation/console or for harness fault injection.

## 4. Security problems found

| # | Problem | Where | Plan |
|---|---|---|---|
| S1 | Approval endpoint CSRF-able (`ACAO: *`, no origin check) | `ui/server.ts` | Same-origin check + JSON content type required |
| S2 | Session token placed in event payloads | `ui/server.ts`, `scripts/run-demo.ts` | Never read tokens; redact URLs/values at capture time and again at display |
| S3 | Submit endpoint fabricates an "Alex Chen" application when nothing was filed (fake success) | `demo-app/server/server.ts` (P1) | Minimal fix: 409 when no completed application exists |
| S4 | Step 1 defaults missing name/ID to "Alex Chen" | same | Minimal fix: 400 on missing required fields |
| S5 | Failure-injection and refresh endpoints are unauthenticated GETs reachable by the agent's browser | same | Documented limitation (synthetic demo) |
| S6 | Service workers could bypass request routing | capture | `serviceWorkers: 'block'` |

## 5. Test coverage gaps
No tests for capture, DOM facts, guard-before-dispatch, approval revalidation, portal behaviour in a browser, GHOST discrimination/read-only probes, CHRONOS last-good/diff/malformed events, UI rendering, or any E2E flow.

## 6. Files to modify / create

Create: `src/capture/{browser,domFacts,redact,approval,executor,portalAgent}.ts` (browser.ts rewritten),
`src/ghost/{prober,minimize}.ts`, `src/chronos/timeline.ts` (rewrite, API-compatible),
`demo-app/pages/index.html` (rewrite), `demo-app/failures/{injector,payloads}.ts`,
`demo-app/fixtures/personas.json`, `ui/{runController,server}.ts`, `ui/index.html` (rewrite),
`tests/unit/{redact,chronos,ghost}.test.ts`, `tests/e2e/*.test.ts`.

Minimal shared changes: `src/core/types.ts` (add `INCONCLUSIVE`, three additive `EventType`s);
`demo-app/server/server.ts` (S3, S4); `tsconfig.json` (`allowImportingTsExtensions`, `noEmit`);
`package.json` (playwright, typescript, scripts).

## 7. Implementation order
1. Tooling (deps, tsconfig, scripts). 2. Capture + redaction. 3. DomFacts + guarded executor + approval gate.
4. Portal, failures, fixtures. 5. GHOST. 6. CHRONOS. 7. Run controller + UI server + dashboard.
8. E2E tests. 9. Full test/typecheck pass, completion report.
