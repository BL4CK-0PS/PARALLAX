/**
 * Redaction applied to every piece of evidence before it is stored or displayed.
 *
 * Redaction happens at capture time (so secrets never reach the event store or
 * the JSONL files) and again at display time in the Command Center (defence in depth).
 */

export const REDACTED = '[REDACTED]';

/** Object keys whose values are never recorded. Anchored to avoid matching e.g. "passed". */
const SENSITIVE_KEY =
  /password|passwd|^pass$|^pwd$|token|cookie|authorization|secret|api[_-]?key|session[_-]?(id|token)|(^|[_-])otp($|[_-])|one[_-]?time|ssn|cvv|cvc|card[_-]?number|cc[_-]?(number|csc|exp)/i;

/** Query parameters whose values are stripped from URLs. */
const SENSITIVE_PARAM = /^(token|access_token|id_token|cookie|cookies|session|sid|auth|authorization|key|api_key|apikey|password|pass|otp|code|secret)$/i;

/** Value-level patterns: the synthetic portal's session tokens and bearer credentials. */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bSES_[A-Z0-9_]+\b/g, '[REDACTED_TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\s;,&#]+/gi, '$1=[REDACTED]']
];

const MAX_DEPTH = 12;
const MAX_STRING = 4000;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Removes credential-bearing query parameters and userinfo from a URL string. */
export function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return redactText(raw);
  }
  if (parsed.username || parsed.password) {
    parsed.username = parsed.username ? 'REDACTED' : '';
    parsed.password = '';
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, REDACTED);
  }
  return redactText(parsed.toString());
}

/** Applies value-level patterns to free text (console messages, error bodies, aria text). */
export function redactText(text: string): string {
  let out = text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  // Inline URLs inside text get the URL treatment too.
  return out.replace(/https?:\/\/[^\s"'<>]+/g, (u) => (u.includes('?') ? redactUrlNoRecurse(u) : u));
}

function redactUrlNoRecurse(raw: string): string {
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

/**
 * Deep-copies a value, redacting sensitive keys, URL parameters and token patterns.
 * Never mutates the input. Cycles and excessive depth are cut rather than followed.
 */
export function redactDeep<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

/** Base64 element screenshots: binary image data, not text; never truncated or pattern-matched. */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** `ancestors` holds only the current path, so shared (non-cyclic) references are kept. */
function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    if (IMAGE_DATA_URL.test(value)) return value;
    return /^https?:\/\//.test(value) ? redactUrl(value) : redactText(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (ancestors.has(value)) return '[CYCLE]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, ancestors));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) && v !== undefined && v !== null && typeof v !== 'boolean' ? REDACTED : walk(v, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
