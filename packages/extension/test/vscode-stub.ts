/**
 * A test double for the slice of the VS Code API the companion uses. Tests
 * alias the 'vscode' import to this file, program its responses through
 * `stub`, and read back what the extension showed.
 */

export interface StubDisposable {
  dispose(): void;
}

/** A command the extension registered, with the handler it registered. */
export interface StubCommand {
  id: string;
  handler: (...args: unknown[]) => unknown;
}

/** A tree view the extension created, with what it revealed. */
export interface StubTreeView {
  id: string;
  provider: unknown;
  revealed: { element: unknown; options?: unknown }[];
}

/** A sign-in session VS Code's authentication API returned. */
export interface StubSession {
  accessToken: string;
}

/** Everything the double recorded, and everything a test can program. */
export interface StubState {
  commands: StubCommand[];
  treeViews: StubTreeView[];
  /** What showInputBox resolves with; undefined reads as dismissed. */
  inputBoxResult: string | undefined;
  warningMessages: string[];
  errorMessages: string[];
  progressTitles: string[];
  sessionRequests: { id: string; scopes: string[]; createIfNone: boolean }[];
  /** What getSession resolves with; undefined reads as no sign-in. */
  session: StubSession | undefined;
  /** When set, getSession rejects, as cancelling the editor's sign-in flow does. */
  cancelSignIn: boolean;
  reset(): void;
}

export const stub: StubState = {
  commands: [],
  treeViews: [],
  inputBoxResult: undefined,
  warningMessages: [],
  errorMessages: [],
  progressTitles: [],
  sessionRequests: [],
  session: undefined,
  cancelSignIn: false,
  reset() {
    stub.commands = [];
    stub.treeViews = [];
    stub.inputBoxResult = undefined;
    stub.warningMessages = [];
    stub.errorMessages = [];
    stub.progressTitles = [];
    stub.sessionRequests = [];
    stub.session = undefined;
    stub.cancelSignIn = false;
  },
};

/** The tree item the double hands out; the extension fills its fields. */
export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  collapsibleState?: number;
  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

/** The collapsible states the extension passes. */
export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

/** The event emitter the tree provider signals changes with. */
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): StubDisposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): StubDisposable {
    stub.commands.push({ id, handler });
    return { dispose: () => undefined };
  },
};

export const window = {
  showInputBox(): Promise<string | undefined> {
    return Promise.resolve(stub.inputBoxResult);
  },
  showWarningMessage(message: string): Promise<void> {
    stub.warningMessages.push(message);
    return Promise.resolve();
  },
  showErrorMessage(message: string): Promise<void> {
    stub.errorMessages.push(message);
    return Promise.resolve();
  },
  async withProgress(
    options: { title?: string },
    task: (progress: { report(): void }) => Promise<unknown>,
  ): Promise<unknown> {
    stub.progressTitles.push(options.title ?? '');
    return task({ report: () => undefined });
  },
  createTreeView(id: string, options: { treeDataProvider: unknown }): StubTreeView & StubDisposable {
    const revealed: { element: unknown; options?: unknown }[] = [];
    const view = {
      id,
      provider: options.treeDataProvider,
      revealed,
      reveal: (element: unknown, revealOptions?: unknown): Promise<void> => {
        revealed.push({ element, options: revealOptions });
        return Promise.resolve();
      },
      dispose: (): void => undefined,
    };
    stub.treeViews.push(view);
    return view;
  },
};

export const authentication = {
  getSession(
    id: string,
    scopes: readonly string[],
    options: { createIfNone?: boolean },
  ): Promise<StubSession | undefined> {
    stub.sessionRequests.push({
      id,
      scopes: [...scopes],
      createIfNone: options.createIfNone ?? false,
    });
    if (stub.cancelSignIn) {
      return Promise.reject(new Error('User did not consent to login.'));
    }
    return Promise.resolve(stub.session);
  },
};

/** An extension context with the subscriptions activate records. */
export function stubContext(): { subscriptions: StubDisposable[] } {
  return { subscriptions: [] };
}
