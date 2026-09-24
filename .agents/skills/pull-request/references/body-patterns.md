# Composing a PR body

Read when deciding how to explain a change. These are choices to make from the reader’s needs, not a sequence or a set of required sections. See [examples.md](examples.md) for complete bodies and [visual-patterns.md](visual-patterns.md) for ways to show relationships.

## Orient the reader

Briefly name the change and what prompted it. Either can come first when it makes the explanation easier to follow. A summary sentence gives the reasoning a subject; an inventory of edits leaves the reasoning to the reader.

For example:

> This moves ownership of the shared connection from the editor to the workspace. The editor and preview can close independently, so neither view’s lifetime can safely determine when their shared connection closes.

For a narrow fix, the failure and the reason the fix addresses it may be the whole body. Expand when the reader needs more to judge the choice.

## Explain why this shape fits

Find the decision that connects the problem to the implementation. A description of the new arrangement alone may leave that decision implicit.

For ownership changes, explain why the chosen owner has the right lifetime or responsibility. For a public API, show a real call site and explain which caller need it serves. For a deletion, explain why the removed behavior or guarantee is no longer needed and what its users do instead.

Discuss alternatives when they clarify a consequential choice. Name concrete complexity or limitations; let the reader judge them. Avoid manufacturing an argument for an obvious fix or recounting abandoned approaches that no longer explain the result.

## Show what the reasoning depends on

Use an example or diagram where the reader would otherwise have to reconstruct behavior or relationships from prose. Choose the smallest representation that supports the claim. Before and after can reveal a changed contract; an ownership tree can explain a lifetime decision; a table can expose a tradeoff.

Public API, CLI, HTTP, config, and type-signature changes need code examples. Show enough input, output, or surrounding use to make the contract clear. Check these against the final implementation. Internal edits need examples only when they help explain the decision.

Use [visual-patterns.md](visual-patterns.md) for possible forms. The prose around a visual should orient the reader and explain its consequence.

## Make consequences explicit

Name meaningful costs, limitations, and changed guarantees alongside the reason for accepting them. Quantify claims when supported by evidence. If behavior stays stable through a refactor, say so when that stability matters to understanding the scope.

Breaking changes need old and new usage, who is affected, and what they must do. A list of removed public names can help migration; a list of changed files repeats the diff.

For example:

> The connection stays open even when the workspace has no open views. That keeps it available when a view reopens; closing the workspace disconnects it.

## Organize around understanding

Use paragraphs while the reader can follow the explanation without signposts. Add concept headings when they help readers navigate distinct decisions or features. A release or migration guide may benefit from a contents list when readers need to find their affected API.

Order the material by what the reader needs to understand next. Explain dependencies when one decision relies on another. Implementation chronology belongs only when the history explains the final choice. Secondary improvements need their own rationale if they matter enough to include.

For stacked PRs, state the dependency and merge order, for example: `Stacks on #1591; merge that first.` Add a review path when a particular reading order helps someone evaluate the change. File and commit counts rarely explain a decision; omit them unless scale itself matters.

The main [skill](../SKILL.md) owns repository conventions for headings, verification reporting, titles, and changelogs. Apply those conventions without turning them into a body template.
