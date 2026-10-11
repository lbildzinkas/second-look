import type * as vscode from 'vscode';

/** The global-state key the steps' ticks are kept under. */
const STEP_TICKS_KEY = 'second-look.stepTicks';

/** The steps that carry an "I've checked these" tick: the claims and the criteria. */
export type StepTick = 'claims' | 'criteria';

/** Every step that carries a tick. */
export const STEP_TICKS: readonly StepTick[] = ['claims', 'criteria'];

/** The ticks of one pull request, as the side bar shows them. */
export type StepTicks = Record<StepTick, boolean>;

/** No step ticked. */
export const NO_TICKS: StepTicks = { claims: false, criteria: false };

/** A commit, as the store records one. */
const COMMIT = /^[0-9a-f]{40,64}$/i;

/** What the store keeps for one pull request: each ticked step, with the head commit it was ticked at. */
type StoredPullRequest = Partial<Record<StepTick, string>>;

/** The store's shape: the ticked steps of every pull request reviewed on this machine. */
interface StoredTicks {
  version: 1;
  pullRequests: Record<string, StoredPullRequest>;
}

/** Whether a value is the store's contents; anything else reads as empty rather than trusted. */
function isStoredTicks(value: unknown): value is StoredTicks {
  if (typeof value !== 'object' || value === null) return false;
  const { version, pullRequests } = value as Record<string, unknown>;
  if (version !== 1 || typeof pullRequests !== 'object' || pullRequests === null) return false;
  return Object.values(pullRequests).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      Object.entries(entry).every(
        ([step, commit]) => (STEP_TICKS as readonly string[]).includes(step) && typeof commit === 'string' && COMMIT.test(commit),
      ),
  );
}

/**
 * The steps' "I've checked these" ticks (the design's step ticks), kept
 * per pull request in the extension's global state, which outlives the
 * editor: a tick records the head commit it was ticked at, so new commits
 * re-open the step — the tick reads as cleared until the reviewer checks
 * the step again at the new head.
 */
export class StepTickStore {
  private readonly state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.state = state;
  }

  /** The ticks that hold at a head commit; a tick made at another commit, such as before new commits landed, reads as cleared. */
  read(url: string, head: string): StepTicks {
    const stored = this.stored().pullRequests[url];
    return { claims: stored?.claims === head, criteria: stored?.criteria === head };
  }

  /** Ticks or clears one step's tick for a pull request at the head commit shown, and answers the ticks as they now stand. */
  async check(url: string, head: string, step: StepTick, checked: boolean): Promise<StepTicks> {
    const stored = this.stored();
    const pullRequest: StoredPullRequest = { ...(stored.pullRequests[url] ?? {}) };
    if (checked) pullRequest[step] = head;
    else delete pullRequest[step];
    await this.state.update(STEP_TICKS_KEY, { version: 1, pullRequests: { ...stored.pullRequests, [url]: pullRequest } } satisfies StoredTicks);
    return { claims: pullRequest.claims === head, criteria: pullRequest.criteria === head };
  }

  /** The store's contents; an entry that is not a tick is left out rather than trusted. */
  private stored(): StoredTicks {
    const value = this.state.get(STEP_TICKS_KEY);
    return isStoredTicks(value) ? value : { version: 1, pullRequests: {} };
  }
}
