import { createHash } from 'node:crypto';
import type { ElementHandle } from 'playwright';
import type { DomFacts } from '../core/types.ts';

/** Upper bound for any single fact string, so a huge element cannot flood the ledger. */
const MAX_FACT_LENGTH = 300;

const FACT_KEYS: ReadonlyArray<keyof DomFacts> = [
  'tagName', 'text', 'ariaLabel', 'inputType', 'name', 'autocomplete', 'value', 'href', 'formAction'
];

/**
 * Runs inside the page against the live element. Must be self-contained (it is serialised).
 *
 * Privacy rule: the `value` of a data-entry control (text, password, email, textarea...)
 * is never read. `value` is only taken from button-like controls, where it is a label.
 */
function readFactsInPage(el: Element): Record<string, string | null> | null {
  if (!el.isConnected) return null;
  const tag = el.tagName.toLowerCase();
  const attr = (n: string): string | null => el.getAttribute(n);
  const buttonLikeInputs = ['submit', 'button', 'reset', 'image'];

  let text: string | null = null;
  let value: string | null = null;
  let inputType: string | null = null;

  if (el instanceof HTMLInputElement) {
    inputType = (attr('type') ?? 'text').toLowerCase();
    if (buttonLikeInputs.includes(inputType)) value = el.value;
  } else if (el instanceof HTMLSelectElement) {
    // Only the currently selected option's label, not every option in the list.
    text = el.selectedOptions.length > 0 ? el.selectedOptions[0].label : null;
  } else if (el instanceof HTMLTextAreaElement) {
    text = null; // user-entered content: never read
  } else if (el instanceof HTMLButtonElement) {
    inputType = (attr('type') ?? 'submit').toLowerCase();
    value = attr('value');
    text = el.innerText;
  } else if (el instanceof HTMLElement) {
    text = el.innerText;
  } else {
    text = el.textContent;
  }

  // Resolved href: the element itself or the nearest enclosing link.
  const anchor = el.closest('a[href], area[href]');
  const href = anchor instanceof HTMLAnchorElement || anchor instanceof HTMLAreaElement ? anchor.href : null;

  // Resolved form target: formaction override on the submitter, else the enclosing form's action.
  let formAction: string | null = null;
  if (el instanceof HTMLFormElement) {
    formAction = el.action;
  } else if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.hasAttribute('formaction')) {
    formAction = el.formAction;
  } else {
    const form = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.form : el.closest('form');
    formAction = form ? form.action : null;
  }

  return {
    tagName: tag,
    text,
    ariaLabel: attr('aria-label'),
    inputType,
    name: attr('name') ?? (el.id ? el.id : null),
    autocomplete: attr('autocomplete'),
    value,
    href,
    formAction
  };
}

/**
 * Validates and normalises what came back from the page into the shared DomFacts contract.
 * Anything that is not a non-empty string is dropped; whitespace is collapsed; lengths are capped.
 * Throws if the result is not usable, so callers fail closed.
 */
export function normalizeDomFacts(raw: unknown): DomFacts {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('DOM inspection returned no element facts.');
  }
  const record = raw as Record<string, unknown>;
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const collapsed = v.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return undefined;
    return collapsed.length > MAX_FACT_LENGTH ? collapsed.slice(0, MAX_FACT_LENGTH) : collapsed;
  };

  const tagName = clean(record.tagName);
  if (!tagName) throw new Error('DOM inspection returned an element without a tag name.');

  const facts: DomFacts = { tagName: tagName.toLowerCase() };
  for (const key of FACT_KEYS) {
    if (key === 'tagName') continue;
    const v = clean(record[key]);
    if (v !== undefined) facts[key] = v;
  }
  return facts;
}

/** Reads DomFacts from the live element. Throws (fail closed) if the element is gone. */
export async function extractDomFacts(handle: ElementHandle<Element>): Promise<DomFacts> {
  // The function is passed by reference so Playwright serialises its source into the page.
  const raw = await handle.evaluate(readFactsInPage);
  return normalizeDomFacts(raw);
}

/** Stable fingerprint of a fact set, used to detect DOM changes between decision and dispatch. */
export function fingerprintDomFacts(facts: DomFacts | undefined): string {
  if (!facts) return 'NO_DOM_FACTS';
  const ordered = FACT_KEYS.map((k) => [k, facts[k] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 32);
}

