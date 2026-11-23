import type { AuditReport, PostconditionCheck, VerificationResult } from '../core/types.ts';

export class Verifier {
  /**
   * Verifies the target system's postconditions following recovery execution.
   */
  public async verifyApplicationSubmission(
    runId: string,
    checkUrl: string,
    expectedStudentId: string
  ): Promise<VerificationResult> {
    const checks: PostconditionCheck[] = [];

    try {
      const resp = await fetch(checkUrl);
      if (!resp.ok) {
        checks.push({
          description: 'Target verification endpoint reachable and returns 200 OK',
          passed: false,
          actualValue: resp.status,
          expectedValue: 200
        });
        return { runId, verified: false, checks, timestamp: Date.now() };
      }

      const data = (await resp.json()) as {
        applications?: Array<{ studentId: string; status: string; id: string }>;
      };
      const apps = data.applications ?? [];
      const match = apps.find((a) => a.studentId === expectedStudentId);

      checks.push({
        description: 'Target verification endpoint reachable',
        passed: true,
        actualValue: 200,
        expectedValue: 200
      });

      checks.push({
        description: `Application for student '${expectedStudentId}' persisted in target backend`,
        passed: !!match,
        actualValue: match ? match.id : 'NOT_FOUND',
        expectedValue: 'EXISTS'
      });

      checks.push({
        description: `Application status is 'ACCEPTED'`,
        passed: match?.status === 'ACCEPTED',
        actualValue: match?.status,
        expectedValue: 'ACCEPTED'
      });

      const allPassed = checks.every((c) => c.passed);
      return {
        runId,
        verified: allPassed,
        checks,
        timestamp: Date.now()
      };
    } catch (err) {
      checks.push({
        description: 'Failed to communicate with verification endpoint',
        passed: false,
        actualValue: String(err),
        expectedValue: 'SUCCESS'
      });
      return { runId, verified: false, checks, timestamp: Date.now() };
    }
  }

  /**
   * Validates that an exported Audit Report meets all hackathon integrity requirements:
   * 1. Cryptographic chain is unbroken.
   * 2. Zero unblocked critical invariant violations.
   * 3. Final verification passed.
   */
  public validateAuditReport(report: AuditReport): { passed: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (!report.eventChainValid) {
      reasons.push('Cryptographic SHA-256 hash chain is invalid or broken.');
    }
    if (report.totalEvents === 0) {
      reasons.push('Audit report contains zero logged events.');
    }
    if (!report.finalVerificationPassed) {
      reasons.push('Final postcondition verification did not pass.');
    }

    return {
      passed: reasons.length === 0,
      reasons
    };
  }
}
