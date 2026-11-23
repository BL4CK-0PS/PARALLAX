import type { ActorType, EventRecord, EventType } from './types.ts';

export interface RawBrowserSignal {
  type: 'navigation' | 'network' | 'dom_mutation' | 'console_error' | 'user_input';
  url: string;
  statusCode?: number;
  selector?: string;
  data?: unknown;
  timestamp?: number;
}

/**
 * Normalizes raw browser, DOM, and network signals into canonical PARALLAX EventRecords.
 */
export class EventNormalizer {
  public static normalizeBrowserSignal(
    signal: RawBrowserSignal,
    runId: string
  ): { type: EventType; actor: ActorType; payload: Record<string, unknown> } {
    switch (signal.type) {
      case 'navigation':
        return {
          type: 'DOM_OBSERVED',
          actor: 'BROWSER',
          payload: {
            url: signal.url,
            title: String(signal.data || 'Page Navigation'),
            status: signal.statusCode ?? 200
          }
        };

      case 'network':
        if (signal.statusCode && signal.statusCode >= 400) {
          return {
            type: 'FAILURE_DETECTED',
            actor: 'TARGET_APP',
            payload: {
              url: signal.url,
              statusCode: signal.statusCode,
              error: signal.data || `HTTP ${signal.statusCode} Error`
            }
          };
        }
        return {
          type: 'NETWORK_RESPONSE',
          actor: 'TARGET_APP',
          payload: {
            url: signal.url,
            statusCode: signal.statusCode ?? 200,
            responsePreview: signal.data
          }
        };

      case 'console_error':
        return {
          type: 'FAILURE_DETECTED',
          actor: 'BROWSER',
          payload: {
            url: signal.url,
            error: signal.data || 'Uncaught browser console error'
          }
        };

      case 'user_input':
      default:
        return {
          type: 'ACTION_DISPATCHED',
          actor: 'AGENT',
          payload: {
            url: signal.url,
            target: signal.selector || 'unknown',
            value: signal.data
          }
        };
    }
  }
}
