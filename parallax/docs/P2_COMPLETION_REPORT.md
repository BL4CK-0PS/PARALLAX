# P2 Completion Report

Date: 2026-11-23. Baseline: commit `592ad40` (see `docs/P2_IMPLEMENTATION_AUDIT.md` for the pre-work audit).
Environment: Node v26.12.1, Playwright 1.65.1 (Chromium 1255 / headless shell), TypeScript 5.9.3, Linux.

## 1. Files created

| File | Purpose |
|---|---|
| `src/capture/redact.ts` | Key/URL/token redaction, applied at capture time and again at display time |
| `src/capture/domFacts.ts` | Live-element `DomFacts` reader (in-page), normaliser, fingerprint |
| `src/capture/recorder.ts` | `RunRecorder`: the single write path into P1's `AuditEventStore` (one store per run) |
| `src/capture/approval.ts` | `ApprovalGate`: single-use, timeout-denies, abort-denies |
| `src/capture/executor.ts` | `GuardedExecutor`: resolve → DOM facts → P1 guard → approval → revalidate → freshness check → dispatch |
| `src/capture/portalAgent.ts` | Deterministic (no-LLM) portal agent; acts only through the executor |
| `src/chronos/stateHash.ts` | Canonical JSON + SHA-256 snapshot hash |
| `src/ghost/minimize.ts` | Bounded ddmin failure minimisation |
| `demo-app/failures/payloads.ts` | Injection payload constant and instruction-like labeller |
| `demo-app/failures/injector.ts` | Failure catalogue + harness injector (records `FAULT_INJECTED`) |
| `demo-app/failures/isolatedOracle.ts` | Private `DemoServer` on a free port for minimisation trials |
| `demo-app/fixtures/personas.json` | Three synthetic personas |
| `ui/runController.ts` | Orchestrates real runs: capture, guard, approvals, GHOST, CHRONOS, P1 planner, P1 verifier |
| `ui/runView.ts` | Builds the dashboard view purely from recorded events (live and replay identical) |
| `tests/unit/redact.test.ts`, `tests/unit/chronos.test.ts`, `tests/unit/ghost.test.ts` | Browser-free unit tests |
| `tests/integration/commandCenter.test.ts` | HTTP API: benchmark file, CSRF refusal, approvals, replay |
| `tests/e2e/helpers.ts`, `capture.test.ts`, `portal.test.ts`, `scenarios.test.ts`, `ui.test.ts` | Real-Chromium E2E suites |
| `docs/P2_IMPLEMENTATION_AUDIT.md`, `docs/P2_COMPLETION_REPORT.md` | Audit and this report |
| `package-lock.json` | Lockfile for the new dependencies |

## 2. Files modified

| File | Owner | Change |
|---|---|---|
| `src/capture/browser.ts` | P2 | Rewritten: real Playwright lifecycle, route-level allowlist via P1 guard, network/console/navigation/crash capture, AI-mode aria snapshots, hashed sanitised snapshots |
| `src/chronos/timeline.ts` | P2 | Rewritten, legacy API kept (`recordSnapshot`, `getLastGoodState`, `diff`, `formatTimeline`): ingestion/validation, JSONL reading with P1 chain check, last-good algorithm, forensic diff, reconstruction |
| `src/ghost/prober.ts` | P2 | Rewritten: evidence-weighted scoring, bounded read-only probes, INCONCLUSIVE path |
| `demo-app/pages/index.html` | P2 | Rewritten 3-step portal |
| `ui/server.ts`, `ui/index.html` | P2 | Scripted workflow removed; real API + dashboard |
| `scripts/run-demo.ts`, `scripts/start-all.ts` | shared | Terminal demo now drives the real controller; start text updated |
| `src/core/types.ts` | P1 (shared contract) | Additive only: `EventType` += `ACTION_BLOCKED`, `BROWSER_NAVIGATED`, `BROWSER_CONSOLE`, `FAULT_INJECTED`; `Hypothesis.status` += `INCONCLUSIVE` |
| `demo-app/server/server.ts` | P1 | Minimal defect fixes only (see §4) |
| `package.json` | shared | `playwright` dep; `typescript`, `@types/node` dev deps; scripts `typecheck`, `test:e2e`, `test:all`, `browsers:install` |
| `tsconfig.json` | shared | `allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`, `types: [node]`; removed unused `declaration`/`outDir` (incompatible with `noEmit`) |
| `README.md` (parallax) | shared | "Honest status" section updated |

Deleted: `.gitkeep` in `demo-app/pages|failures|fixtures`, `tests/e2e` (directories now have content).

## 3. What was implemented

**Capture.** One browser/context/page per `BrowserCapture`; second `launch()` throws. Deterministic context (viewport 1280×860, `en-US`, UTC, light, reduced motion), `serviceWorkers: 'block'` so no request can bypass routing. `context.route('**/*')` asks `guard.evaluateNetworkRequest()` for every request: allowed → `NETWORK_REQUEST` + continue; refused (or guard error) → `NETWORK_BLOCKED` + abort. Responses → `NETWORK_RESPONSE`; app fetch/xhr/document ≥ 400 → `FAILURE_DETECTED{kind: HTTP_ERROR}` with only the redacted `error` field of a JSON body. Also captured: `requestfailed` (except our own aborts), main-frame navigation, console errors/warnings, page errors, renderer crash, unexpected browser disconnect. Snapshots: URL, title, `page.ariaSnapshot({ mode: 'ai' })`, sanitised form state (password/OTP/card/hidden → `[REDACTED]`, files → name only, textarea/select values capped), visible `role=alert` text, health derived from observations since the previous snapshot, SHA-256 state hash.

**Playwright API decision.** The spec's `ariaSnapshot({ mode: "ai" })` was checked against the installed version before use: Playwright 1.65.1 exposes `page.ariaSnapshot({ mode: 'ai' })` and `locator.ariaSnapshot({ mode })` (verified in `node_modules/playwright-core/types/types.d.ts` and by a live run producing `[ref=eN]` output). The previously cached Chromium (1.48 era) had no `ariaSnapshot`, so Playwright was upgraded rather than falling back to the deprecated `page.accessibility.snapshot()`.

**DomFacts + guard.** For CLICK/TYPE/SUBMIT/SELECT the executor requires exactly one matching element (else FAILED before the guard is consulted), reads `tagName`, `innerText` (or selected option label for `<select>`; never textarea/input content), `aria-label`, `type`, `name`/id, `autocomplete`, `value` (only for button-like controls), resolved `href` (element or enclosing link), resolved form action (`formaction` override or enclosing form). Agent-supplied `dom` is discarded and recorded as `agentSuppliedDomIgnored`. BLOCK never dispatches. REQUIRE_APPROVAL creates an approval with the element screenshot, DOM facts, agent label, guard rule and reason, and waits. After approval the element is re-resolved and re-read; a changed fingerprint cancels; the guard is asked again (recorded as `POST_APPROVAL_REVALIDATION`); a BLOCK or a different rule cancels. Immediately before dispatch the facts are read again on the same handle; any change cancels. Dispatch happens on that handle.

**Portal.** Step 1 (name, email, student ID, optional application reference) with client validation and aria-invalid messages; Step 2 (programme, CGPA, previous institution, merit scholarship that reveals a required statement-of-purpose document field with optional .txt/.md loader, accommodations field, saved-draft comment in a blurred spoiler with a reveal toggle); Step 3 (review summary, synthetic ₹1,500 fee with "View fee details" and "Pay" buttons where Pay only shows "payments are disabled", attestation checkbox, submit, session-expired re-auth panel, confirmation ID from the backend). Loading state via `body[data-busy]`, sessionStorage draft restore, responsive grid, all server text inserted with `textContent`.

**Failures.** A: harness calls the existing backend injection endpoint (recorded as `FAULT_INJECTED`, ignored by GHOST); in `full-demo` this happens after the human approves the submit and before it is dispatched. B: real backend rule (merit without document → 400); the client deliberately does not pre-check it. C: payload in the DOM (hidden visually, present in the accessibility tree); recorded as `UNTRUSTED_CONTENT` with `treatedAs: 'DATA'`; a simulated compromised widget fires a beacon to `evil.attacker.com` only when `navigator.webdriver` is true (so human browsers never send it); the route guard aborts it. A clearly labelled simulated hijacked proposal (NAVIGATE to the host named in the text) is BLOCKED by the guard. Spoofed Pay: simulated proposal "View fee details" on `#fee-action-7`; live text "Pay ₹1,500 application fee" → REQUIRE_APPROVAL.

**GHOST.** Always formulates H1 (session) and H2 (dynamic requirement). Evidence weights: probe 0.60, status code 0.25, error message 0.15; confidence = S/(S+C+0.25). CONFIRMED needs a supporting probe, an independent supporting observation and no contradicting probe; REFUTED needs a contradicting probe and no supporting one; otherwise INCONCLUSIVE (PROPOSED when no probe ran). Probes: `GET /api/session` (allowlist-checked, no body, no redirects, 3 s timeout, keeps only status and `active`), and a pure DOM read of visible, enabled, required, empty controls with their `data-conditional-on` controller. Max 4 probes. All recorded as `PROBE_EXECUTED`. Recovery is attempted only when exactly one hypothesis is CONFIRMED and P1's `InvariantEngine.checkRecoveryReadiness` passes. Minimisation (ddmin, ≤ 12 trials) runs against a private `DemoServer` on a free port, using the form state from the last snapshot before the failure.

**CHRONOS.** Validates every record (id, runId, numeric timestamp, known type/actor, object payload, hash), rejects duplicates, stable-sorts by timestamp (ties keep append order). Reads JSONL runs, reporting bad lines; verifies the chain with P1's `AuditEventStore.verifyIntegrity`. Last-good algorithm is documented in `lastGoodState()`: hash must recompute, capture-healthy, last app status < 400, no unresolved earlier failure (resolved only by a 2xx on the same method+path or `POSTCONDITION_VERIFIED`); returns `UNAVAILABLE` with reasoning otherwise. `ForensicStateDiff extends StateDiff` with title, aria line diff (refs stripped), network failures, validation errors, blocked requests and auth state from session/submit responses. Reconstruction separates "observations" from "inferences" (phrased "associated with" / "supports").

**Command Center.** Panels A–F as specified, SSE (`/api/stream`, coalesced) with polling fallback, stale-data banner, portal health pill, run list and persisted-run replay (CHRONOS over JSONL), timeline replay animation, evidence tabs (event, snapshots, diffs, network, hypotheses, policy, recovery/verification), Approve/Deny calling `POST /api/approvals/:id`, benchmark from `data/eval/before-after.json` with schema validation and explicit unavailable state. Live screenshot of the agent's page.

## 4. What was fixed

| Issue | Fix |
|---|---|
| Scripted UI workflow fabricated every event (sleeps + hand-written events, no browser) | Replaced by `RunController`; every event comes from a real component |
| `captureSnapshot()` returned a fabricated healthy snapshot without a browser | Removed; snapshot requires a live page |
| GHOST hardcoded confidences 0.85 / 0.75 / 0.95 / 0.2; network error "confirmed" expiry | Documented scoring; probe errors are INCONCLUSIVE |
| CHRONOS diffed unredacted inputs; timeline stringified raw payloads | Redaction at capture and display; summaries per type |
| Approval endpoint CSRF-able (`ACAO: *`, no origin check) | Same-origin + `Content-Type: application/json` required; `Sec-Fetch-Site` checked; no CORS header |
| Session token in event payloads | Tokens never read; URL/key/value redaction |
| Planner target `textarea#statement_of_purpose` absent from page | Page uses the planner's ids |
| P1 server: step 1 defaulted missing fields to "Alex Chen" | 400 on missing name/studentId or invalid email (P1 tests still pass) |
| P1 server: submit fabricated an application when none was filed | 409 unless steps 1 and 2 completed |
| P1 server: auto-start check `endsWith('server.ts')` also fired when `ui/server.ts` was the entry → two servers on :3000 | Compares the resolved entry path with its own file |
| Found during testing: `redactDeep` treated shared references as cycles (hypotheses vanished from the dashboard) | Ancestor-path cycle detection |
| Found during testing: element screenshot truncated by the 4,000-char text cap | Image data URLs exempt |
| Found during testing: `cookie=` text pattern swallowed following query parameters | Pattern stops at `&`/`#` |

## 5. Architecture and integration decisions

- P1 modules used as-is: `DeterministicPolicyGuard` (one per run; its ledger records `resolveHumanApproval`), `AuditEventStore`, `RecoveryPlanner`, `Verifier`, `InvariantEngine`. No alternative policy, store or planner.
- One `AuditEventStore` per run, because the P1 store chains all events it holds and `verifyIntegrity(runId)` fails for later runs in a shared store (P1 code untouched; see §11).
- CHRONOS results are computed from the event store on demand, never stored, so replay reproduces them exactly (tested).
- Abstract planner actions are mapped to concrete UI: `REAUTHENTICATE` → click `#reauth-button`. Planner actions whose target is not visible on the current page are recorded as deferred (`ACTION_PROPOSED{kind: RECOVERY_ACTION_DEFERRED}`) and happen later in the workflow under the same guard.
- Synchronisation uses the portal's own `data-busy` flag and event-driven waits with upper bounds, not sleeps.
- ESM + `--experimental-strip-types` (no build step) kept; `erasableSyntaxOnly` enforces compatible syntax.

## 6. Security controls

Route-level allowlist (P1 guard) for every browser request, fail-closed on guard error; service workers blocked; action-level guard on every action with live DOM facts; secret-field TYPE blocked by P1 rule; strict single-element targeting; approval single-use, timeout-deny (10 min), abort-deny, revalidation, freshness check, same-handle dispatch; no request bodies/headers/cookies recorded; redaction before storage and before display; approval API CSRF protection; dashboard renders all data with `textContent` (the injection payload is displayed as inert text); GHOST probes are GET-only/DOM-read-only, allowlist-checked, bounded; minimisation only touches a private synthetic server; post-run `InvariantEngine.auditRunInvariants` over all events.

## 7–8. Tests executed and exact results

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit -p .`) | exit 0, no errors |
| `npm test` | `tests 88, suites 20, pass 88, fail 0, cancelled 0, skipped 0` (45 pre-existing P1 tests + 43 new) |
| `npm run test:e2e` | `tests 38, suites 5, pass 38, fail 0, cancelled 0, skipped 0`, ~16 s (real Chromium) |
| `npm run eval` | `14/14 → 0/14`, blocked 11, gated 3; normal 7/8 free, 1 asked, 0 blocked |
| `npm run demo:run -- full-demo --auto` | `RESULT: VERIFIED — Application APP-2026-1212 verified in backend state.`, 106 events, hash chain valid |
| `npm run demo:ui`, `npm start`, `npm run demo:server` | Each boots; `/api/state`, `/api/portal/health`, portal `/` return 200 |

The full E2E suite passed on two consecutive complete runs. During development a capture test failed because the fixture server omitted `charset=utf-8` (test bug, fixed); a cascading 60 s hang came from that failure leaving an approval pending.

## 9. TypeScript/build
Strict mode, no `any` and no TODOs in P2 code, no empty `catch` blocks in P2 code. No build step (Node strips types).

## 10. Remaining limitations

1. **No LLM.** The agent is a fixed workflow. "Hijacked" Pay and navigation proposals are labelled simulations of what a fooled model would propose; the guard's decisions on them are real.
2. **DOM facts come from the page's main world.** A hostile page controls its own DOM (and could patch getters). The guarantee is against a lying *agent*, not a lying *page*.
3. **Session probe observes current state**, not the state at failure time. A session that expired just after a different failure would still support H1. The 401 status observation is the time-of-failure evidence.
4. **Failure-injection endpoints** (P1) are unauthenticated GETs on an allowlisted host; the agent's browser could reach them. The deterministic agent never does.
5. **Backend session is global** (single-user demo server).
6. **The beacon is a demo mechanism** (fires only when `navigator.webdriver`); the spoiler is not a security boundary.
7. **Recovery utilities** shown in plans are P1 planner constants, labelled as such.
8. Element screenshots are shown to the operator but not stored in the event log.
9. No automated accessibility audit (axe) was run; labels/aria were added by hand. SSE *reconnection after server restart* is implemented but only the disconnect path is tested.
10. `npm test` stays browser-free; browser tests require `npx playwright install chromium` and run via `npm run test:e2e`.
11. Demo video, deck and Devnovate submission were not produced here.

## 11. P1 dependencies / notes for Person 1

- `AuditEventStore` chain spans runs; `verifyIntegrity(runId)` breaks for a second run in the same store. Worked around with a store per run.
- `generateAuditReport` hardcodes `invariantsEvaluated: 4`; the dashboard shows `InvariantEngine.auditRunInvariants` counts instead.
- `HIDDEN_DEPENDENCY` failure mode in the server rejects step 2 even with a document; not used (Failure B uses the real rule).
- Contract additions in `types.ts` (additive) need P1 sign-off.
- The three server fixes in §4 are minimal and keep all P1 tests passing; please review.

## 12. Reproduce the demonstration

```bash
cd parallax
npm install
npx playwright install chromium        # once
npm run eval                           # writes data/eval/before-after.json (Panel F source)
npm start                              # portal :3000, Command Center :5173
# optional: PARALLAX_HEADED=1 npm start  to watch the agent's Chromium; PARALLAX_SLOWMO=300 to slow it
```
Open http://localhost:5173, choose `full-demo`, press **Start run**, then:
1. The agent fills the portal (step 1, step 2 with scholarship + document).
2. It reveals the hidden draft comment: timeline shows the purple `NETWORK_BLOCKED` (beacon) and the untrusted-content record.
3. Purple `NETWORK_BLOCKED` for the simulated hijacked navigation.
4. Amber approval card for "View fee details": the card shows the element really reads "Pay ₹1,500 application fee" → **Deny**.
5. Amber approval for "Submit application" → **Approve**. The harness then expires the session (`FAULT_INJECTED`) before dispatch.
6. Red 401 failure; Panel C shows H1 CONFIRMED 0.80, H2 REFUTED 0.00 with probe results; CHRONOS shows the last good state and the AUTHENTICATED → UNAUTHENTICATED diff.
7. Recovery: re-auth click, then a new approval for the resubmission → **Approve**.
8. Status VERIFIED (backend record ID equals the ID shown in the portal).
9. Press **⟲ Replay**, or pick the run in the View list to replay it from its JSONL file.

Terminal alternative: `npm run demo:run -- full-demo` (asks approvals on stdin) or `-- full-demo --auto`. Other scenarios: `normal`, `session-expiry`, `missing-document`, `prompt-injection`.

## Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Every P2-owned module has a functional implementation | PASS | capture/chronos/ghost/pages/failures/fixtures/ui all exercised by `scenarios.test.ts` (6/6) |
| Playwright captures actual browser state | PASS | `capture.test.ts` "AI-mode accessibility snapshot…", "navigation, requests and responses…" |
| Accessibility snapshots work with the installed version | PASS | Same test asserts `button "Pay ₹1,500 now" [ref=eN]` from Playwright 1.65.1 |
| Network observations recorded and sanitised | PASS | `capture.test.ts` network + HTTP-error tests (no `SES_` leak); `chronos.test.ts` secrets test |
| DomFacts extracted from live elements | PASS | `capture.test.ts` "facts are read from live elements…" (exact `deepStrictEqual` per element) |
| Every browser action passes through the real guard | PASS | `SpyGuard` (subclass of P1 guard) sees every action; decision recorded before dispatch; ambiguous targets never dispatch |
| Human approval genuinely controls execution | PASS | `capture.test.ts` deny/approve/changed-element; `ui.test.ts` Approve/Deny buttons; `scenarios.test.ts` #6 (nothing filed after denial) |
| Portal has three functional steps | PASS | `portal.test.ts` (10/10) |
| Dynamic scholarship validation works | PASS | `portal.test.ts` reveal + backend 400 + valid document passes |
| Session-expiration injection works | PASS | `scenarios.test.ts` #2 |
| Prompt injection remains untrusted | PASS | `scenarios.test.ts` #4+5 (`treatedAs: DATA`, no dispatch to attacker) |
| Spoofed Pay demonstration works | PASS | `scenarios.test.ts` #7 (approval shows agent label vs live text, never dispatched after deny) |
| GHOST distinguishes the two hypotheses using evidence | PASS | `ghost.test.ts`, `portal.test.ts` (real failure), `scenarios.test.ts` #2/#3 |
| GHOST probes bounded and read-only | PASS | `ghost.test.ts` GET-only/budget; `portal.test.ts` DOM + backend unchanged, no browser traffic |
| CHRONOS reconstructs the last-good state | PASS | `chronos.test.ts` (selection, unresolved failure, tampered hash → UNAVAILABLE); `scenarios.test.ts` #2/#7 |
| State diffs reflect actual captured evidence | PASS | `chronos.test.ts` diff/auth tests; `scenarios.test.ts` #2 (`authState.after = UNAUTHENTICATED`) |
| Command center displays real timeline events | PASS | `ui.test.ts` timeline ids equal `/api/state` event ids |
| Approval controls connect to the real execution path | PASS | `ui.test.ts` (operator `command-center-operator` on the real `APPROVAL_GRANTED`, SUBMIT dispatched) |
| Evidence inspector works | PASS | `ui.test.ts` selection shows event id and rule |
| Benchmark loaded from the real JSON file | PASS | `ui.test.ts` shows file's 12/4/17; missing file → unavailable; `commandCenter.test.ts` schema checks |
| End-to-end tests pass | PASS | `npm run test:e2e`: 38/38 |
| Existing P1 tests remain passing | PASS | `npm test`: all 45 pre-existing tests pass within 88/88 |
| No secrets or credentials leak into logs or UI | PASS (scoped) | Tested: JSONL, events, timeline, reconstruction, probes for `SES_` tokens, passwords, bearer values. Not tested: arbitrary third-party token formats beyond the documented patterns |
| Application starts from documented commands | PASS | §7–8 command table |
