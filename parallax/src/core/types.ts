/**
 * PARALLAX Core Domain Contracts and Types
 * Version: 1.1.0
 * Authors: BL4CK_0P$ (Track 2: Beyond the Browser, wHACKiest 2026)
 */

export const PARALLAX_VERSION = '1.1.0';

export type EventType =
  | 'DOM_OBSERVED'
  | 'ACTION_PROPOSED'
  | 'ACTION_DISPATCHED'
  | 'ACTION_EXECUTION_FAILED'
  | 'NETWORK_REQUEST'
  | 'NETWORK_BLOCKED'
  | 'NETWORK_RESPONSE'
  | 'FAILURE_DETECTED'
  | 'HYPOTHESIS_FORMULATED'
  | 'PROBE_EXECUTED'
  | 'RECOVERY_PROPOSED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'POSTCONDITION_VERIFIED'
  | 'POSTCONDITION_FAILED';

export type ActorType =
  | 'AGENT'
  | 'GUARD'
  | 'HUMAN'
  | 'BROWSER'
  | 'TARGET_APP'
  | 'VERIFIER';

export type ActionType =
  | 'NAVIGATE'
  | 'CLICK'
  | 'TYPE'
  | 'SELECT'
  | 'WAIT'
  | 'SUBMIT'
  | 'REAUTHENTICATE';

export interface Action {
  id: string;
  type: ActionType;
  target: string;
  value?: string;
  isStateChanging: boolean;
  humanLabel: string;
  metadata?: Record<string, unknown>;
}

export type PolicyStatus = 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';

export interface PolicyDecision {
  status: PolicyStatus;
  reason: string;
  violatedRule?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  action: Action;
  timestamp: number;
}

export interface PolicyLedgerEntry {
  id: string;
  runId: string;
  timestamp: number;
  decision: PolicyDecision;
  humanResolution?: {
    resolvedBy: string;
    decision: 'APPROVED' | 'DENIED';
    timestamp: number;
    notes?: string;
  };
}

export interface EventRecord {
  id: string;
  runId: string;
  timestamp: number;
  type: EventType;
  actor: ActorType;
  payload: Record<string, unknown>;
  hash: string;
  previousHash?: string;
}

export interface StateSnapshot {
  step: number;
  url: string;
  title: string;
  ariaSnapshot?: string;
  formInputs: Record<string, string>;
  activeSessionId?: string;
  lastHttpStatusCode?: number;
  timestamp: number;
  isHealthy: boolean;
}

export interface StateDiff {
  stepFrom: number;
  stepTo: number;
  urlChanged: boolean;
  fromUrl: string;
  toUrl: string;
  inputsModified: Record<string, { from: string; to: string }>;
  sessionStatusChanged: boolean;
  healthChanged: boolean;
}

export type FailureCategory =
  | 'SESSION_EXPIRY'
  | 'HIDDEN_DEPENDENCY'
  | 'NETWORK_REJECTION'
  | 'PROMPT_INJECTION'
  | 'DOM_NOT_FOUND'
  | 'UNKNOWN';

export interface Hypothesis {
  id: string;
  runId: string;
  claim: string;
  category: FailureCategory;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  confidenceScore: number; // 0.0 - 1.0
  status: 'PROPOSED' | 'CONFIRMED' | 'REFUTED';
}

export interface RecoveryCandidate {
  id: string;
  strategyName: string;
  actions: Action[];
  expectedBenefitScore: number; // 0.0 - 1.0
  riskScore: number;            // 0.0 - 1.0 (lower is better)
  compositeUtilityScore: number; // 0.0 - 1.0
  requiresHumanApproval: boolean;
  predictedOutcome: string;
}

export interface RecoveryPlan {
  id: string;
  runId: string;
  hypothesisId: string;
  strategyName: string;
  selectedCandidate: RecoveryCandidate;
  alternativeCandidates: RecoveryCandidate[];
  actions: Action[];
  predictedOutcome: string;
  riskAssessment: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface PostconditionCheck {
  description: string;
  passed: boolean;
  actualValue?: unknown;
  expectedValue?: unknown;
}

export interface VerificationResult {
  runId: string;
  verified: boolean;
  checks: PostconditionCheck[];
  timestamp: number;
}

export interface AuditReport {
  runId: string;
  generatedAt: number;
  totalEvents: number;
  eventChainValid: boolean;
  invariantsEvaluated: number;
  invariantsPassed: number;
  blockedThreats: number;
  approvalsRequested: number;
  approvalsGranted: number;
  recoveryExecutions: number;
  finalVerificationPassed: boolean;
  headHash: string;
}
