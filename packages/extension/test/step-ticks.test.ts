import { beforeEach, describe, expect, it } from 'vitest';
import { NO_TICKS, StepTickStore } from '../src/side-bar/step-ticks.js';
import { stub, stubContext } from './vscode-stub.js';

/** The head commit the reviews of the tests stand at, and a later one new commits move it to. */
const HEAD = 'f00dcafe1234567890abcdef1234567890abcdef12';
const NEW_HEAD = '998ded4a1234567890abcdef1234567890abcdef12';
const URL = 'https://github.com/example-org/example-repo/pull/42';

describe('the step ticks the side bar keeps per pull request', () => {
  beforeEach(() => stub.reset());

  it('holds nothing until a step is ticked, and keeps the tick for the pull request it was ticked for', async () => {
    const store = new StepTickStore(stubContext().globalState);
    expect(store.read(URL, HEAD)).toEqual(NO_TICKS);
    expect(await store.check(URL, HEAD, 'claims', true)).toEqual({ claims: true, criteria: false });
    expect(store.read(URL, HEAD)).toEqual({ claims: true, criteria: false });
    // Another pull request keeps its own ticks.
    expect(store.read('https://github.com/example-org/example-repo/pull/43', HEAD)).toEqual(NO_TICKS);
  });

  it('re-opens a ticked step once new commits move the head, and takes the tick again at the new head', async () => {
    const store = new StepTickStore(stubContext().globalState);
    await store.check(URL, HEAD, 'claims', true);
    await store.check(URL, HEAD, 'criteria', true);
    expect(store.read(URL, NEW_HEAD)).toEqual(NO_TICKS);
    expect(await store.check(URL, NEW_HEAD, 'claims', true)).toEqual({ claims: true, criteria: false });
    // Each step remembers the last head it was ticked at, so the criteria tick stays with the head it was taken on.
    expect(store.read(URL, HEAD)).toEqual({ claims: false, criteria: true });
  });

  it('clears a tick without touching the other step, and keeps the ticks across a store read afresh', async () => {
    await new StepTickStore(stubContext().globalState).check(URL, HEAD, 'claims', true);
    const store = new StepTickStore(stubContext().globalState);
    expect(store.read(URL, HEAD)).toEqual({ claims: true, criteria: false });
    expect(await store.check(URL, HEAD, 'criteria', true)).toEqual({ claims: true, criteria: true });
    expect(await store.check(URL, HEAD, 'claims', false)).toEqual({ claims: false, criteria: true });
  });

  it('reads an entry that is not a tick as empty rather than trusting it', async () => {
    const store = new StepTickStore(stubContext().globalState);
    await store.check(URL, HEAD, 'claims', true);
    const stored = stub.globalState['second-look.stepTicks'] as { version: unknown; pullRequests: Record<string, Record<string, unknown>> };
    stored.pullRequests[URL] = { claims: 'not a commit' };
    expect(store.read(URL, HEAD)).toEqual(NO_TICKS);
    stored.version = 2;
    expect(await store.check(URL, HEAD, 'criteria', true)).toEqual({ claims: false, criteria: true });
    expect(store.read(URL, HEAD)).toEqual({ claims: false, criteria: true });
  });
});
