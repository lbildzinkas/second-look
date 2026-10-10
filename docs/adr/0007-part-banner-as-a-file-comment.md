# The part banner is a file comment at the top of the part's diff

The reviewing surface puts a banner above the selected part's diff with the part's importance and its one-line reason, the signals, the asks and the reviewed checkbox. VS Code has no native banner above its multi-file diff editor, so the companion shows it as the editor's own file comment: a read-only comment thread at no line on the part's first file — on its head side, or its base side when that file is deleted — which the editor shows at the top of that file, where the part's diff starts. The thread holds one comment, the banner, in trusted Markdown whose links run only the commands the part's context menu and its tree checkbox already run, carrying the part by where it starts; so the banner, the context menu and the tree checkbox act through the same code and stay in step. It is the mechanism the findings already use for a finding on a whole part, so it adds no new kind of editor surface.

## Considered Options

- A CodeLens line at the top of the part's first file: rejected, because VS Code's diff editors hide CodeLens unless the reviewer turns on the `diffEditor.codeLens` setting, which is off by default, and a CodeLens line holds only short link texts, with no room for the reason and the signals.
- A small webview header: rejected, because an extension cannot place a webview inside or above the multi-file diff editor; it would be a separate editor or panel away from the diff, which is the story reader's drawback the reviewing surface turned down.
- Buttons in the diff editor's title bar: rejected, because the title bar holds icons and no text, so it cannot show the importance, its reason or the signals.
- A webview inset in the editor: rejected, because that API is proposed and an extension that uses it cannot be published.

## Consequences

The banner sits at the top of the part's first file and scrolls with the diff rather than staying pinned above it. One part has a banner at a time: opening the whole change shows none, since it is no one part. Like every comment thread, the banner is also listed in the editor's Comments panel.
