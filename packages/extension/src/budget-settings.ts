import * as vscode from 'vscode';
import type { BudgetLimits } from '@second-look/engine';

/**
 * The budget settings (issue 111): limits on what one review may use —
 * agent runs, files fetched and mebibytes downloaded — each 0 for no
 * limit, the default. Like the agent settings they live in the user
 * settings only, since they bound what a review may do, and every review
 * request carries them, so the engine meters the review against them and
 * its result shows the use so far. Nothing is refused yet.
 */

/**
 * Reads the budget limits. A value that is not a limit — negative, not a
 * number, or a fraction where a count is due — limits nothing, so a
 * hand-edited setting never stops a review.
 */
export function readBudgetLimits(): BudgetLimits {
  const configuration = vscode.workspace.getConfiguration('second-look');
  const count = (key: string): number => {
    const value = configuration.get<unknown>(key, 0);
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  };
  const mib = configuration.get<unknown>('budget.downloadMiB', 0);
  return {
    agentRuns: count('budget.agentRuns'),
    filesFetched: count('budget.filesFetched'),
    downloadMiB: typeof mib === 'number' && Number.isFinite(mib) && mib >= 0 ? mib : 0,
  };
}
