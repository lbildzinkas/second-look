# Second Look glossary

An editor add-on that helps a human review a pull request faster and better: it orders the change by what matters, checks claims against real code, and lets the reviewer comment back to GitHub.

## Language

### People and the tool

**Reviewer**:
The human reviewing a pull request with the companion's help.
_Avoid_: User, developer

**Companion**:
The review tool itself, which serves the reviewer and never reviews or posts in their place.
_Avoid_: Bot, review bot, assistant

### Reading the change

**Story**:
A few sentences at the top of a review that tell what the change does, in the order the parts should be read.
_Avoid_: Walkthrough, tour, summary

**Part**:
A named group of related edits; every changed line belongs to exactly one part.
_Avoid_: Chunk, section, group, file

**Importance**:
The level a part is given for review: **must review**, **worth reviewing**, or **context**, always with a one-line reason.
_Avoid_: Priority, severity, critical

**Signal**:
A plain, model-free fact about a part (for example new versus changed code, or how much other code depends on it) that ranking must cite.
_Avoid_: Heuristic, feature

**Noise**:
A part whose changes need no careful reading, such as a lockfile or a generated file; it is **confirmed** when a check proved it and **claimed** otherwise. A snapshot or fixture part is labelled but never sunk, because a change there is a behaviour change.
_Avoid_: Boilerplate, trivial change

### Checking claims

**Claim**:
A statement about how the code or a library behaves, made by the pipeline, the PR description, a docstring or comment in the change, or the companion's own agent.
_Avoid_: Assertion

**Verdict**:
The outcome of checking a claim: **verified**, **refuted**, **unverifiable**, or **not checked**, always with its evidence.
_Avoid_: Result, status, score

**Evidence source**:
Where a verdict's evidence came from: the change itself, library source at the pinned version, a named repository (a library's repository at a tag the agent named, weaker than pinned source), a CI log, the issue text, or the model's memory; model memory never yields **verified**.
_Avoid_: Citation, reference

**Library fetch**:
A reviewer-started download of one library's source at the version the project pins — or, when nothing pins it, at a repository and tag the agent named — offered by the companion with its reason only when a claim cannot be checked without it.
_Avoid_: Dependency sync, auto-fetch, install

### Acting on the review

**Acceptance criterion**:
One condition from the linked issue that the change must meet, proven by code, automated tests, or a manual check the PR reports.
_Avoid_: Requirement, AC item

**Manual check**:
Verification a person performed and the PR reports, such as steps followed or a screenshot, as opposed to an automated test.
_Avoid_: Manual test, QA

**Finding**:
Anything the companion reports to the reviewer about a part, such as a refuted claim, an unmet acceptance criterion, or an unexplained change.
_Avoid_: Issue, alert, warning

**Tested model**:
An agent, model and effort combination the companion's evaluation has been run against, with published results.
_Avoid_: Supported model, certified model

**Ask**:
A fixed, typed request the reviewer makes about one part for deeper analysis, such as "explain" or "verify this claim".
_Avoid_: Chat, prompt, question

**Comment**:
A review comment the reviewer sends to GitHub from the companion, as part of one pending GitHub review.
_Avoid_: Bot comment, annotation

**Draft comment**:
A comment the companion prepares from a finding, which the reviewer edits and sends or discards.
_Avoid_: Suggestion, auto-comment
