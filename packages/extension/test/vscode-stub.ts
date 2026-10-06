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

/** A command the extension executed through the editor's command registry. */
export interface StubExecutedCommand {
  id: string;
  args: unknown[];
}

/** A tree view the extension created, with what it revealed. */
export interface StubTreeView {
  id: string;
  provider: unknown;
  revealed: { element: unknown; options?: unknown }[];
  /** The selected nodes; a test selects a node by setting it. */
  selection: unknown[];
  /** The status line the extension shows above the tree. */
  message?: string;
}

/** A sign-in session VS Code's authentication API returned. */
export interface StubSession {
  accessToken: string;
}

/** A file system provider the extension registered, with its options. */
export interface StubFileSystemProvider {
  scheme: string;
  provider: unknown;
  options?: { isCaseSensitive?: boolean; isReadonly?: boolean | StubMarkdownString };
}

/** A decoration type the extension created, with the style it asked for. */
export interface StubDecorationType extends StubDisposable {
  options: Record<string, unknown>;
}

/** A status bar item the extension created, with what it last showed. */
export interface StubStatusBarItem extends StubDisposable {
  id: string;
  alignment: number;
  priority: number | undefined;
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown;
  shown: boolean;
  show(): void;
  hide(): void;
}

/** A comment the extension put in a thread, as the editor renders it. */
export interface StubComment {
  body: string | StubMarkdownString;
  mode: number;
  author: { name: string; iconPath?: Uri };
  label?: string;
  contextValue?: string;
}

/** A comment thread the extension created, settable the way the editor sets one. */
export interface StubCommentThread {
  readonly uri: Uri;
  range: Range | undefined;
  comments: StubComment[];
  collapsibleState: number;
  canReply: boolean | { name: string };
  contextValue?: string;
  label?: string;
  state?: number;
  dispose(): void;
}

/** A comment controller the extension created, with the threads it shows. */
export interface StubCommentController extends StubDisposable {
  id: string;
  label: string;
  options?: { placeHolder?: string; prompt?: string };
  commentingRangeProvider?: {
    provideCommentingRanges(document: { uri: Uri }, token?: unknown): unknown;
  };
  threads: StubCommentThread[];
  createCommentThread(
    uri: Uri,
    range: Range | undefined,
    comments: StubComment[],
  ): StubCommentThread;
}

/** A webview the extension created: the page it holds, and its messages. */
export interface StubWebview {
  /** The source a page's content security policy would allow. */
  readonly cspSource: string;
  /** The HTML the extension set for the page. */
  html: string;
  /** The options the extension created the panel with. */
  options: { enableScripts?: boolean };
  /** The messages the extension posted to the page, in order. */
  posted: unknown[];
  /** Delivers a message as the page's own script would send it. */
  receive(message: unknown): void;
  /** Posts a message to the page: the extension's own direction. */
  postMessage(message: unknown): Thenable<boolean>;
  /** Registers the extension's listener for the page's messages. */
  onDidReceiveMessage(listener: (message: unknown) => void): StubDisposable;
}

/** A webview panel the extension created, as the slice the companion uses. */
export interface StubWebviewPanel extends StubDisposable {
  viewType: string;
  title: string;
  /** How many times the extension revealed the panel. */
  reveals: number;
  webview: StubWebview;
  /** Registers a listener for the panel's closing, as the editor fires it. */
  onDidDispose(listener: () => void): StubDisposable;
  /** Brings the panel back to the front, as the extension asks. */
  reveal(): void;
}

/** A theme colour the extension asked for, by its id. */
export class ThemeColor {
  constructor(readonly id: string) {}
}

/** The MarkdownString of a readonly file system's reason. */
export class StubMarkdownString {
  constructor(readonly value: string) {}
}

/** Everything the double recorded, and everything a test can program. */
export interface StubState {
  commands: StubCommand[];
  executedCommands: StubExecutedCommand[];
  treeViews: StubTreeView[];
  fileSystemProviders: StubFileSystemProvider[];
  decorationTypes: StubDecorationType[];
  statusBarItems: StubStatusBarItem[];
  commentControllers: StubCommentController[];
  /** The webview panels the extension created, in order. */
  webviewPanels: StubWebviewPanel[];
  /** The configuration values `getConfiguration` reads, keyed by `section.key`. */
  configuration: Record<string, unknown>;
  /** The editors currently visible; tests set these and fire the change. */
  visibleTextEditors: unknown[];
  /** The file contents behind `file:` URIs, keyed by path. */
  files: Map<string, Uint8Array>;
  /** What showInputBox resolves with; undefined reads as dismissed, and a pending promise holds the box open. */
  inputBoxResult: string | undefined | Promise<string | undefined>;
  /** The input boxes shown: the title and value each opened with. */
  inputBoxes: { title?: string; value?: string }[];
  /** What showQuickPick resolves with; undefined reads as dismissed. */
  quickPickResult: unknown;
  /** The quick picks shown: their titles and the items they offered. */
  quickPicks: { title: string; items: unknown[] }[];
  warningMessages: string[];
  errorMessages: string[];
  informationMessages: string[];
  /** What showInformationMessage resolves with; undefined reads as dismissed. */
  informationChoice: string | undefined;
  /** The URIs the extension opened in the browser, as strings. */
  openedExternals: string[];
  progressTitles: string[];
  sessionRequests: { id: string; scopes: string[]; createIfNone: boolean }[];
  /** What getSession resolves with; undefined reads as no sign-in. */
  session: StubSession | undefined;
  /** When set, getSession rejects, as cancelling the editor's sign-in flow does. */
  cancelSignIn: boolean;
  reset(): void;
  /** Fires the visible-editors change the way the editor does. */
  fireVisibleTextEditors(editors: unknown[]): void;
  /** Fires the configuration change the way the editor does. */
  fireConfigurationChange(): void;
}

const visibleEditorListeners = new Set<(editors: unknown[]) => void>();
const configurationListeners = new Set<(event: StubConfigurationChangeEvent) => void>();

export const stub: StubState = {
  commands: [],
  executedCommands: [],
  treeViews: [],
  fileSystemProviders: [],
  decorationTypes: [],
  statusBarItems: [],
  commentControllers: [],
  webviewPanels: [],
  configuration: {},
  visibleTextEditors: [],
  files: new Map(),
  inputBoxResult: undefined,
  inputBoxes: [],
  quickPickResult: undefined,
  quickPicks: [],
  warningMessages: [],
  errorMessages: [],
  informationMessages: [],
  informationChoice: undefined,
  openedExternals: [],
  progressTitles: [],
  sessionRequests: [],
  session: undefined,
  cancelSignIn: false,
  reset() {
    stub.commands = [];
    stub.executedCommands = [];
    stub.treeViews = [];
    stub.fileSystemProviders = [];
    stub.decorationTypes = [];
    stub.statusBarItems = [];
    stub.commentControllers = [];
    stub.webviewPanels = [];
    stub.configuration = {};
    stub.visibleTextEditors = [];
    visibleEditorListeners.clear();
    configurationListeners.clear();
    stub.files = new Map();
    stub.inputBoxResult = undefined;
    stub.inputBoxes = [];
    stub.quickPickResult = undefined;
    stub.quickPicks = [];
    stub.warningMessages = [];
    stub.errorMessages = [];
    stub.informationMessages = [];
    stub.informationChoice = undefined;
    stub.openedExternals = [];
    stub.progressTitles = [];
    stub.sessionRequests = [];
    stub.session = undefined;
    stub.cancelSignIn = false;
  },
  fireVisibleTextEditors(editors: unknown[]) {
    stub.visibleTextEditors = editors;
    for (const listener of visibleEditorListeners) {
      listener(editors);
    }
  },
  fireConfigurationChange() {
    // The double reports every section as affected; tests plant the values
    // they mean before firing.
    const event: StubConfigurationChangeEvent = {
      affectsConfiguration: () => true,
    };
    for (const listener of configurationListeners) {
      listener(event);
    }
  },
};

/** The tree item the double hands out; the extension fills its fields. */
export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  collapsibleState?: number;
  command?: { command: string; title: string; arguments?: unknown[] };
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

/**
 * A URI double: the components an extension builds URIs from, compared by
 * their string form. Unlike the editor's, it does not percent-encode.
 */
export class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = '',
  ) {}

  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
      components.query,
      components.fragment,
    );
  }

  static file(path: string): Uri {
    return new Uri('file', '', path.startsWith('/') ? path : `/${path}`);
  }

  static parse(value: string): Uri {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(
      value,
    );
    if (match === null) {
      throw new Error(`not a URI: ${value}`);
    }
    return new Uri(match[1]!, match[3] ?? '', match[4] ?? '', match[6] ?? '', match[8] ?? '');
  }

  /** The file system path of a `file:` URI; other schemes read the path. */
  get fsPath(): string {
    if (this.scheme !== 'file') return this.path;
    return process.platform === 'win32' ? this.path.replace(/^\//, '').replace(/\//g, '\\') : this.path;
  }

  with(change: { scheme?: string; authority?: string; path?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      this.query,
      this.fragment,
    );
  }

  toString(): string {
    const authority = this.authority !== '' ? `${this.authority}` : '';
    const query = this.query !== '' ? `?${this.query}` : '';
    const fragment = this.fragment !== '' ? `#${this.fragment}` : '';
    return `${this.scheme}://${authority}${this.path}${query}${fragment}`;
  }

  toJSON(): { scheme: string; authority: string; path: string; query: string; fragment: string } {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }
}

/** A position in a text document, 0-based. */
export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

/** A range in a text document, 0-based. */
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(
    startOrLine: Position | number,
    startCharacterOrEnd: Position | number,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (startOrLine instanceof Position && startCharacterOrEnd instanceof Position) {
      this.start = startOrLine;
      this.end = startCharacterOrEnd;
    } else {
      this.start = new Position(startOrLine as number, startCharacterOrEnd as number);
      this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    }
  }
}

/** The file types a file system can report. */
export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

/** The permissions a file can carry. */
export const FilePermission = {
  Readonly: 1,
} as const;

/** How an editor can reveal a range. */
export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;

/** The error a file system reports, with the case a test checks. */
export class FileSystemError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
  }
  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(text(messageOrUri, 'not found'), 'FileNotFound');
  }
  static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(text(messageOrUri, 'is a directory'), 'FileIsADirectory');
  }
  static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(text(messageOrUri, 'not a directory'), 'FileNotADirectory');
  }
  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(text(messageOrUri, 'no permissions'), 'NoPermissions');
  }
  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(text(messageOrUri, 'unavailable'), 'Unavailable');
  }
}

function text(messageOrUri: string | Uri | undefined, fallback: string): string {
  if (messageOrUri === undefined) return fallback;
  return typeof messageOrUri === 'string' ? messageOrUri : messageOrUri.toString();
}

/** The double behind `file:` URIs: the contents a test planted. */
const plantedFiles = {
  async stat(uri: Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
    const content = stub.files.get(uri.path);
    if (content === undefined) throw FileSystemError.FileNotFound(uri);
    return { type: FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
  },
  async readFile(uri: Uri): Promise<Uint8Array> {
    const content = stub.files.get(uri.path);
    if (content === undefined) throw FileSystemError.FileNotFound(uri);
    return content;
  },
  async readDirectory(): Promise<[string, number][]> {
    return [];
  },
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    stub.files.set(uri.path, content);
  },
};

async function providerFor(uri: Uri): Promise<unknown> {
  if (uri.scheme === 'file') return plantedFiles;
  const registered = stub.fileSystemProviders.find((entry) => entry.scheme === uri.scheme);
  if (registered === undefined) {
    throw FileSystemError.Unavailable(`no file system provider for ${uri.scheme}`);
  }
  return registered.provider;
}

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): StubDisposable {
    // The real registry serves one handler per command id and rejects a
    // second registration of the same id, so the double rejects one too.
    if (stub.commands.some((command) => command.id === id)) {
      throw new Error(`command '${id}' already exists`);
    }
    stub.commands.push({ id, handler });
    return { dispose: () => undefined };
  },
  executeCommand(id: string, ...args: unknown[]): PromiseLike<unknown> {
    stub.executedCommands.push({ id, args });
    return Promise.resolve(undefined);
  },
};

export const window = {
  showInputBox(options?: { title?: string; value?: string }): Promise<string | undefined> {
    stub.inputBoxes.push({ title: options?.title, value: options?.value });
    return Promise.resolve(stub.inputBoxResult);
  },
  showQuickPick(items: unknown[], options?: { title?: string }): Promise<unknown> {
    stub.quickPicks.push({ title: options?.title ?? '', items });
    return Promise.resolve(stub.quickPickResult);
  },
  showWarningMessage(message: string): Promise<void> {
    stub.warningMessages.push(message);
    return Promise.resolve();
  },
  showErrorMessage(message: string): Promise<void> {
    stub.errorMessages.push(message);
    return Promise.resolve();
  },
  showInformationMessage(message: string, ..._items: string[]): Promise<string | undefined> {
    stub.informationMessages.push(message);
    return Promise.resolve(stub.informationChoice);
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
    const view: StubTreeView & StubDisposable & { reveal(element: unknown, options?: unknown): Promise<void> } = {
      id,
      provider: options.treeDataProvider,
      revealed,
      selection: [],
      message: undefined,
      reveal: (element: unknown, revealOptions?: unknown): Promise<void> => {
        revealed.push({ element, options: revealOptions });
        if ((revealOptions as { select?: boolean } | undefined)?.select) view.selection = [element];
        return Promise.resolve();
      },
      dispose: (): void => undefined,
    };
    stub.treeViews.push(view);
    return view;
  },
  get visibleTextEditors(): unknown[] {
    return stub.visibleTextEditors;
  },
  onDidChangeVisibleTextEditors(listener: (editors: unknown[]) => void): StubDisposable {
    visibleEditorListeners.add(listener);
    return { dispose: () => visibleEditorListeners.delete(listener) };
  },
  createTextEditorDecorationType(options: Record<string, unknown>): StubDecorationType {
    const type: StubDecorationType = { options, dispose: () => undefined };
    stub.decorationTypes.push(type);
    return type;
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    _showOptions: number | { viewColumn: number },
    options?: { enableScripts?: boolean },
  ): StubWebviewPanel {
    const listeners = new Set<(message: unknown) => void>();
    const closing = new Set<() => void>();
    const webview: StubWebview = {
      cspSource: 'https://second-look.test',
      html: '',
      options: options ?? {},
      posted: [],
      receive(message: unknown): void {
        for (const listener of listeners) {
          listener(message);
        }
      },
      postMessage(message: unknown): Thenable<boolean> {
        webview.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener: (message: unknown) => void): StubDisposable {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const panel: StubWebviewPanel = {
      viewType,
      title,
      reveals: 0,
      webview,
      reveal: (): void => {
        panel.reveals += 1;
      },
      onDidDispose(listener: () => void): StubDisposable {
        closing.add(listener);
        return { dispose: () => closing.delete(listener) };
      },
      dispose: (): void => {
        stub.webviewPanels = stub.webviewPanels.filter((entry) => entry !== panel);
        listeners.clear();
        for (const listener of closing) {
          listener();
        }
        closing.clear();
      },
    };
    stub.webviewPanels.push(panel);
    return panel;
  },
  createStatusBarItem(id: string, alignment = StatusBarAlignment.Left, priority?: number): StubStatusBarItem {
    const item: StubStatusBarItem = {
      id,
      alignment,
      priority,
      text: '',
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      shown: false,
      show: (): void => {
        item.shown = true;
      },
      hide: (): void => {
        item.shown = false;
      },
      dispose: (): void => {
        stub.statusBarItems = stub.statusBarItems.filter((entry) => entry !== item);
      },
    };
    stub.statusBarItems.push(item);
    return item;
  },
};

/** The configuration-change event the editor fires, as the double reports it. */
export interface StubConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export const MarkdownString = StubMarkdownString;

/** The sides of the status bar an item can sit on. */
export const StatusBarAlignment = {
  Left: 0,
  Right: 1,
} as const;

/** The modes a comment can be shown in. */
export const CommentMode = {
  Editing: 0,
  Preview: 1,
} as const;

/** The columns a panel can open in. */
export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;

/** The states a comment thread can be shown in. */
export const CommentThreadCollapsibleState = {
  Collapsed: 0,
  Expanded: 1,
} as const;

/** The comment threads' API, as the slice the companion uses. */
export const comments = {
  createCommentController(id: string, label: string): StubCommentController {
    const controller: StubCommentController = {
      id,
      label,
      threads: [],
      createCommentThread(uri, range, commentList) {
        const thread: StubCommentThread = {
          uri,
          range,
          comments: commentList,
          collapsibleState: CommentThreadCollapsibleState.Collapsed,
          canReply: true,
          dispose: (): void => {
            controller.threads = controller.threads.filter((entry) => entry !== thread);
          },
        };
        controller.threads.push(thread);
        return thread;
      },
      dispose: (): void => {
        stub.commentControllers = stub.commentControllers.filter(
          (entry) => entry !== controller,
        );
      },
    };
    stub.commentControllers.push(controller);
    return controller;
  },
};

/** The environment outside the editor, as the slice the companion uses. */
export const env = {
  openExternal(uri: Uri): Thenable<boolean> {
    stub.openedExternals.push(uri.toString());
    return Promise.resolve(true);
  },
};

export const workspace = {
  getConfiguration(section: string): { get<T>(key: string, defaultValue?: T): T | undefined } {
    return {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        (stub.configuration[`${section}.${key}`] as T | undefined) ?? defaultValue,
    };
  },
  onDidChangeConfiguration(
    listener: (event: StubConfigurationChangeEvent) => void,
  ): StubDisposable {
    configurationListeners.add(listener);
    return { dispose: () => configurationListeners.delete(listener) };
  },
  registerFileSystemProvider(
    scheme: string,
    provider: unknown,
    options?: { isCaseSensitive?: boolean; isReadonly?: boolean | StubMarkdownString },
  ): StubDisposable {
    stub.fileSystemProviders.push({ scheme, provider, options });
    return {
      dispose: () => {
        stub.fileSystemProviders = stub.fileSystemProviders.filter(
          (entry) => entry.provider !== provider,
        );
      },
    };
  },
  fs: {
    stat(uri: Uri): PromiseLike<{ type: number; ctime: number; mtime: number; size: number }> {
      return providerFor(uri).then((provider) =>
        (provider as { stat(uri: Uri): PromiseLike<never> }).stat(uri),
      );
    },
    readFile(uri: Uri): PromiseLike<Uint8Array> {
      return providerFor(uri).then((provider) =>
        (provider as { readFile(uri: Uri): PromiseLike<Uint8Array> }).readFile(uri),
      );
    },
    readDirectory(uri: Uri): PromiseLike<[string, number][]> {
      return providerFor(uri).then((provider) =>
        (provider as { readDirectory(uri: Uri): PromiseLike<[string, number][]> }).readDirectory(
          uri,
        ),
      );
    },
    writeFile(uri: Uri, content: Uint8Array): PromiseLike<void> {
      return providerFor(uri).then((provider) =>
        (
          provider as {
            writeFile(
              uri: Uri,
              content: Uint8Array,
              options: { create: boolean; overwrite: boolean },
            ): PromiseLike<void>;
          }
        ).writeFile(uri, content, { create: true, overwrite: true }),
      );
    },
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
