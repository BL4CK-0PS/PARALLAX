# PARALLAX
### Autonomous Digital Reality Intelligence

> **Observe the present. Reconstruct the past. Challenge the system. Simulate the future. Verify every action.**

[![Hackathon](https://img.shields.io/badge/wHACKiest%202026-CodeRIT%20%7C%20RIT%20Bengaluru-orange.svg)](#)
[![Track](https://img.shields.io/badge/Track%202-Beyond%20the%20Browser-purple.svg)](#)
[![Team](https://img.shields.io/badge/Team-BL4CK__0P%24-black.svg)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](#)
[![Playwright](https://img.shields.io/badge/Playwright-1.65-green.svg)](#)
[![Runtime Security](https://img.shields.io/badge/Policy-Deterministic%20Fail--Closed-red.svg)](#)

---

## Overview

PARALLAX is an autonomous digital reality intelligence platform designed to govern, diagnose, and recover complex browser automation tasks. Rather than letting LLMs operate as unconstrained black-box agents, PARALLAX:
1. **Reconstructs History (CHRONOS):** Captures full DOM and network state diffs to pinpoint where a workflow broke.
2. **Conducts Controlled Experiments (GHOST):** Discriminates failure hypotheses (e.g. session drops vs. missing form dependencies) safely.
3. **Simulates Recovery (MIRROR):** Evaluates bounded recovery candidates before executing them.
4. **Enforces Deterministic Security:** Hard network allowlists, secret-field bans, and human confirmation gates for state-changing actions.

For full architectural blueprints, diagrams, and getting started instructions, see the **[Root Repository README](../README.md)** and the technical specifications in the root directory.

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
