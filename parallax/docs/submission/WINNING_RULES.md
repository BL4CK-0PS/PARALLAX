# Winning rules (living checklist)

Distilled from hackathon-winning advice the team collects (videos, talks, judge feedback).
Each rule says what it means **for PARALLAX specifically** and where it is applied.
Add new sources at the bottom; merge rules that repeat instead of duplicating them.

| # | Rule | What it means for us | Applied in |
|---|---|---|---|
| 1 | Research the problem, not ideas | Ground the problem in real incidents and reports, not ChatGPT-suggested keywords | Deck slide 2 evidence; `PITCH_DECK_CONTENT.md` sources |
| 2 | One specific user, never "everyone" | AI/automation engineers at ed-tech, fintech and HR companies shipping form-filling agents | Deck slide 2 "Who we build for" |
| 3 | Remove friction for that user | Normal workflow steps must not be blocked; only irreversible steps ask, once | `src/eval` measures friction (8 normal steps: 0 blocked, 1 approval) |
| 4 | Few features, one sharp USP | 3 features (Guard / Diagnose / Replay); USP = safety holds even when the AI is fooled | Deck slide 3 |
| 5 | No jargon in the description | Lead with plain words; engine names (CHRONOS/GHOST/MIRROR) only when asked how | Deck slide 3; speaker notes |
| 6 | Open with an audience question | "Raise your hand if you'd let an AI agent submit your scholarship form with your bank details" | Slide 2 speaker notes |
| 7 | Show evidence and the cost of the problem | Brave/Comet OTP leak, OpenAI "never fully solved", Gartner 40%+ cancellations | Deck slide 2 |
| 8 | Demo is a movie: problem → tension → solution, told in order | One continuous run of one user's story (hidden text → blocked → disguised Pay → asked → session expires → diagnosed → approved → verified → replay); the solution gets ~90% of the time | `DEMO_VIDEO_SCRIPT.md`; slide 3 flow + notes |
| 9 | Before/after with real numbers | 14/14 harmful actions run alone → 0/14 with PARALLAX, measured by `npm run eval` | Deck slide 7; `BEFORE_AFTER.md` |
| 10 | Know USP, features and competitors cold | Q&A answers prepared for ChatGPT Agent, Comet, Browser Use, firewalls, RPA | `PITCH_DECK_CONTENT.md` Q&A |
| 11 | Never lie or overclaim | Every number sourced or measured; say plainly what's scripted or basic | Removed an unsourced "78%" stat and unverified version/perf claims |
| 12 | Plan the demo while building | Whoever builds a feature also decides how it shows in the demo | `TASK_SPLIT.md` demo-readiness items |
| 13 | Judges only see the demo, never the repo | Anything we want credit for (fail-closed design, hash chain, measured numbers) must be visible on screen in the video | `DEMO_VIDEO_SCRIPT.md` |
| 14 | Visual and tangible: something judges can play with | Attack playground at `/playground`: live 14→0 counter, "try to beat the guard" boxes, real guard verdicts | `ui/playground.html`, `ui/playground.ts` |
| 15 | Judges score technical complexity, impact, completeness | Complexity: show the event hash chain + DOM-grounded gate; impact: before/after; completeness: one unbroken end-to-end run | Video script beats |
| 16 | Pick ideas by their demo path; split essential vs nice-to-have | MUST items keep the demo alive; everything else is optional and gets cut first | `TASK_SPLIT.md` MUST / NICE list |
| 17 | Use libraries for depth | Playwright for real browser capture and CDP blocking rather than hand-rolled scraping | P2: `npm i playwright` |
| 18 | Simplify when stuck, never perfect | If the real Playwright agent loop isn't stable, ship the scripted run + playground, labelled honestly | `TASK_SPLIT.md` fallback |
| 19 | Start the demo video early; video beats description | Record a fallback take today; organisers watch the video, not the README | `DEMO_VIDEO_SCRIPT.md` |
| 20 | Never miss the deadline | Internal deadline 24 Nov 20:00 IST; official 23:59 IST | `TASK_SPLIT.md` submission checklist |
| 21 | Show you're here to build it for real | Close with what we'll do after the hackathon (open-source guard, pilots); know the judges' tech | Slide 8 notes; video ending |

## Sources
1. YouTube: "15 hackathons, 11 wins" (Scaler School of Technology student; 4-step framework: understand the problem → user-oriented product → unique solution → sell it in the pitch). Added 2026-11-23.
2. YouTube: hackathon organiser's 5 tips (lockbox method: show you're building a real startup; AA method: visual, tangible, playable; idea before the event; start coding immediately; never miss the deadline, perfection loses). Added 2026-11-23.
3. YouTube: Sophia, 7-win streak and LA Hacks tech director (Gavel pairwise judging; judges weigh complexity, impact, completeness from the demo alone; choose ideas by demo path; demo as a movie; essential vs nice-to-have; API contracts; libraries; visuals; simplify; start the video early). Added 2026-11-23.
