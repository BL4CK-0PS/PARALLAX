import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, ActionType, DomFacts } from '../src/core/types.ts';
import { DeterministicPolicyGuard } from '../src/policy/guard.ts';
import { runBeforeAfter } from '../src/eval/beforeAfter.ts';
import { ATTACKS, BENIGN } from '../src/eval/scenarios.ts';

const HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'playground.html');
const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD = 500;
const ACTION_TYPES: ActionType[] = ['NAVIGATE', 'CLICK', 'TYPE', 'SELECT', 'SUBMIT'];
const DOM_KEYS: (keyof DomFacts)[] = ['tagName', 'text', 'ariaLabel', 'inputType', 'name', 'autocomplete', 'value', 'href', 'formAction'];

export type PlaygroundVerdict =
  | { ok: true; outcome: 'EXECUTED' | 'BLOCKED' | 'NEEDS_APPROVAL'; reason: string; rule?: string }
  | { ok: false; error: string };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_FIELD) : undefined;

/**
 * Evaluates one visitor-supplied input with a fresh guard.
 * Accepts { url } for a raw request, or { action: { type, target?, value?, humanLabel?, dom? } }.
 * Only whitelisted fields are copied, so nothing else reaches the guard.
 */
export function evaluatePlaygroundInput(input: unknown): PlaygroundVerdict {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Body must be a JSON object.' };
  const body = input as Record<string, unknown>;
  const guard = new DeterministicPolicyGuard();

  const url = str(body.url);
  if (url) {
    const net = guard.evaluateNetworkRequest(url);
    return net.allowed
      ? { ok: true, outcome: 'EXECUTED', reason: net.reason }
      : { ok: true, outcome: 'BLOCKED', reason: net.reason, rule: 'RULE_NETWORK_ALLOWLIST' };
  }

  if (typeof body.action !== 'object' || body.action === null) {
    return { ok: false, error: 'Provide either "url" or "action".' };
  }
  const raw = body.action as Record<string, unknown>;
  const type = raw.type as ActionType;
  if (!ACTION_TYPES.includes(type)) return { ok: false, error: `action.type must be one of ${ACTION_TYPES.join(', ')}.` };

  let dom: DomFacts | undefined;
  if (typeof raw.dom === 'object' && raw.dom !== null) {
    const d = raw.dom as Record<string, unknown>;
    dom = { tagName: str(d.tagName) ?? 'unknown' };
    for (const key of DOM_KEYS) {
      const v = str(d[key]);
      if (v !== undefined) dom[key] = v;
    }
  }

  const action: Action = {
    id: 'playground',
    type,
    target: str(raw.target) ?? '#element',
    value: str(raw.value),
    isStateChanging: false,
    humanLabel: str(raw.humanLabel) ?? 'Unlabelled action',
    dom
  };
  const decision = guard.evaluateAction(action, 'playground');
  const outcome = decision.status === 'ALLOW' ? 'EXECUTED' : decision.status === 'BLOCK' ? 'BLOCKED' : 'NEEDS_APPROVAL';
  return { ok: true, outcome, reason: decision.reason, rule: decision.violatedRule };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Serves the attack playground. Returns true if the request was handled.
 *   GET  /playground        interactive before/after page
 *   GET  /api/eval          before/after report over the fixed scenario set
 *   POST /api/guard/check   evaluate a visitor's own URL or action
 */
export function handlePlaygroundRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (pathname === '/playground' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_PATH, 'utf-8'));
    return true;
  }

  if (pathname === '/api/eval' && req.method === 'GET') {
    sendJson(res, 200, runBeforeAfter([...ATTACKS, ...BENIGN]));
    return true;
  }

  if (pathname === '/api/guard/check' && req.method === 'POST') {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { ok: false, error: 'Body too large.' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'Body must be valid JSON.' });
        return;
      }
      const verdict = evaluatePlaygroundInput(parsed);
      sendJson(res, verdict.ok ? 200 : 400, verdict);
    });
    return true;
  }

  return false;
}
