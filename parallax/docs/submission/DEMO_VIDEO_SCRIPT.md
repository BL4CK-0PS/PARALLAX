# Demo video script (Round 1 YouTube, 3–5 min, unlisted)

**Rule:** tell it like a movie. One user, one run, told in order: problem → tension → solution.
The solution gets about 90% of the screen time. Judges never open the repo, so anything we want credit for must be on screen.

**Record a fallback take today** with whatever works, then re-record if there's time. A submitted video beats a perfect one.

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:20 | Portal homepage | "Priya is an engineer at an ed-tech company. Her AI agent fills scholarship applications for students like Alex. Tonight it's filling Alex's merit-scholarship form, and someone has hidden an instruction on the page." |
| 0:20–0:35 | Reveal the hidden text in the remarks box | "Humans can't see this. The agent can. Last year the same trick made Perplexity's Comet leak a user's OTP." |
| 0:35–1:10 | Command Center: start the run; events stream in | "Here's the agent with PARALLAX in front of the browser. It fills Alex's name and student ID…" |
| 1:10–1:40 | Red BLOCKED event: request to evil.attacker.com | "…reads the hidden text and tries to send the session to the attacker. Blocked in the browser, before a single byte leaves. The AI was fooled; it didn't matter." |
| 1:40–2:10 | Approval card shows the **real button text** | "Now it tries to press a button it calls 'View fee details'. The page says 'Pay ₹5,000'. PARALLAX reads the page, not the AI, so it stops and asks Priya." *(needs P2's Pay button; skip if not ready)* |
| 2:10–2:50 | Session expires → CHRONOS diff → GHOST probe → MIRROR plan | "Then the login expires mid-form. Instead of retrying blindly, PARALLAX finds the exact step, probes the session (401) and picks the safe fix: re-authenticate, replay step 2." |
| 2:50–3:20 | Final Submit approval → Approve → verified, application ID | "Final submit always asks a human. Approved. The verifier checks the backend: the application really exists." |
| 3:20–3:50 | Replay timeline + "chain verified" | "Every step is recorded and hash-chained. Priya can replay exactly what happened, and prove nobody edited the log." |
| 3:50–4:30 | `/playground`: press Replay; counters reach 14 vs 0; try the "@" URL trick live | "We tested 14 attack techniques. On its own, the agent runs all 14. With PARALLAX, zero. Normal steps aren't blocked; only the final submit asks. Try to beat it yourself." |
| 4:30–5:00 | Slide 8 / team | "We're BL4CK_0P$. We're open-sourcing the guard and taking this past the hackathon with pilots on real admission portals." |

## What must be on screen (judging: complexity, impact, completeness)
- **Complexity:** the blocked request at the browser layer, the approval card quoting the real page text, the hash-chain check.
- **Impact:** the 14 → 0 counter and one sentence on who's protected (students' OTPs and fees).
- **Completeness:** one unbroken run from task to verified submission. Don't jump between disconnected features.

## Honesty lines (say them if they apply)
- If the agent path is scripted: "The agent follows a scripted path in this demo; the guard, backend and verifier are real."
- Numbers are "after the model is fooled", not a detection rate.

## Recording checklist
- 1080p, browser zoom 125%, close other tabs, notifications off.
- `npm run dev`, then open `http://localhost:5173` and `http://localhost:5173/playground`.
- Rehearse once with a timer. Upload as **unlisted**, check it plays logged-out, then paste the link into Devnovate.
