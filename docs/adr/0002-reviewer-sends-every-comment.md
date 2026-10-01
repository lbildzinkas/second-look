# The reviewer sends every comment

The companion can draft comments from its findings, but every comment reaches GitHub only when the reviewer presses send, as part of one pending GitHub review the reviewer submits. The companion never posts on its own: it exists to make the human review better, not to add another review bot, and keeping the human as author also keeps write access in the reviewer's hands.

## Considered Options

- No GitHub comments at all in v1, leaving commenting to the GitHub extension or github.com: rejected, because switching tools to comment is part of the pain the companion removes.
- Automatic posting of findings, as review bots do: rejected; every bot competitor already does this, and it would make the companion a bot.
