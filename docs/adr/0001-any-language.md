# Any language, no restriction

The companion must work on pull requests in any programming language. Python and .NET are the first test targets because they are the first maintainers' stacks, but no part of the design may assume them: language- or ecosystem-specific checks plug in as adapters, and where no adapter exists the companion still works and states plainly which checks it could not run, rather than refusing or silently skipping.

## Considered Options

- C# and Python only for v1 (the original recommendation): rejected, because an open-source community tool limited to two stacks would need its core reworked to grow.
