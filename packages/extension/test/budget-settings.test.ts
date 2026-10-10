import { beforeEach, describe, expect, it } from 'vitest';
import { stub } from './vscode-stub.js';
import { readBudgetLimits } from '../src/budget-settings.js';

describe('readBudgetLimits', () => {
  beforeEach(() => stub.reset());

  it('limits nothing by default', () => {
    expect(readBudgetLimits()).toEqual({ agentRuns: 0, filesFetched: 0, downloadMiB: 0 });
  });

  it('reads the three limits the settings carry', () => {
    stub.configuration = {
      'second-look.budget.agentRuns': 25,
      'second-look.budget.filesFetched': 400,
      'second-look.budget.downloadMiB': 12.5,
    };
    expect(readBudgetLimits()).toEqual({ agentRuns: 25, filesFetched: 400, downloadMiB: 12.5 });
  });

  it('reads a value that is no limit as no limit, so a hand-edited setting never stops a review', () => {
    stub.configuration = {
      'second-look.budget.agentRuns': -3,
      'second-look.budget.filesFetched': 2.5,
      'second-look.budget.downloadMiB': '64',
    };
    expect(readBudgetLimits()).toEqual({ agentRuns: 0, filesFetched: 0, downloadMiB: 0 });
  });
});
