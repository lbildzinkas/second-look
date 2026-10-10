import type { ReviewResult } from '@second-look/engine';

/** The editor's own command that opens a folder; the project always opens in a new window. */
export const OPEN_FOLDER_COMMAND = 'vscode.openFolder' as const;

/** The dialog's one button that confirms the load; dismissing the dialog writes and opens nothing. */
export const LOAD_PROJECT_CONFIRM = 'Write and open the project' as const;

/** The warning shown before the project is loaded for navigation: a modal dialog's message and its detail. */
export interface LoadProjectWarning {
  message: string;
  detail: string;
}

/**
 * The warning the reviewer reads before the project is loaded for
 * navigation: what is written and where it opens, what language
 * extensions may run from the pull request once it is open — restoring
 * the project, its build targets, analyzers and source generators, and
 * the interpreters and tools it names — that the folder opens untrusted
 * unless the reviewer trusts it, or opens trusted when the editor's
 * workspace trust is turned off, and that the agents keep their
 * locked-down posture.
 */
export function loadProjectWarning(result: ReviewResult, isTrustEnabled: boolean): LoadProjectWarning {
  const { head } = result.copies;
  const trust = isTrustEnabled
    ? 'The folder opens untrusted, in Restricted Mode, unless you trust it or already trust a folder that contains it; trusting it lets that code run.'
    : 'Workspace trust is turned off (security.workspace.trust.enabled), so the folder opens trusted and that code can run as soon as it opens.';
  return {
    message: `Load the project of #${result.pullRequest.number} for navigation?`,
    detail: [
      `Second Look will write a writable copy of the head commit ${head.commit.slice(0, 7)} to its cache and open it in a new window, so language extensions can offer go to definition. Nothing is written or opened unless you confirm.`,
      "Language extensions and tools in that window may run code from the pull request: restoring the project (such as dotnet restore, or npm and pip installs with their install scripts), its build targets (MSBuild targets and props, or build scripts), analyzers and source generators, and the interpreters, SDKs and tools the project or its editor settings name. That code runs as you, with your files and your network.",
      trust,
      "The companion's agents keep their locked-down posture: they read only the read-only copies, never this folder.",
    ].join('\n\n'),
  };
}
