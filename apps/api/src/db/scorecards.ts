import type { DB } from "./index.ts";

export const scorecardRepo = (db: DB) => ({
  /** Latest non-revoked FINAL scorecard (approved|attested) of a cycle, for carry-forward. */
  latestFinal(employeeId: string, cycleId: string): { scorecard_id: string; result_json: string } | undefined {
    return db
      .prepare(
        `SELECT scorecard_id, result_json FROM scorecards
          WHERE employee_id = ? AND cycle_id = ? AND status IN ('approved','attested')
          ORDER BY version DESC LIMIT 1`,
      )
      .get(employeeId, cycleId) as { scorecard_id: string; result_json: string } | undefined;
  },
});
export type ScorecardRepo = ReturnType<typeof scorecardRepo>;
