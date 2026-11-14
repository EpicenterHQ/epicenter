# 0905. Secret input makes the whole action confidential

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Amended by:** [ADR-0906](0906-confidentiality-is-explicit-action-metadata.md), replacing schema-marker inference with explicit action metadata.
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md), replacing per-field CLI secret acquisition and nested-marker restrictions. Local storage and the app author's output obligations remain.

## Context

A person connects an app once; agents use its stored connection. Per-field
handling added a terminal editor, several argument refusal paths, and a schema
grammar traversal to reject nested markers. MCP already excluded whole actions.

## Decision

`writeOnly: true` anywhere in an action's input schema JSON makes the whole
action confidential. The marker is reserved even inside defaults, examples,
and custom metadata. The JSON scan does not resolve references. Schemas must
serialize as finite JSON; cyclic JavaScript graphs fail during declaration.

- HTTP accepts the action's JSON object.
- The CLI accepts exactly `--input -`, using its ordinary JSON stdin path.
  It refuses every other spelling before parsing or echoing arguments.
- MCP neither lists nor runs the action.
- Validation returns a fixed refusal for the whole input. It never echoes
  values, undeclared keys, or validator messages.
- Commit subjects use only the app and action names, even if an ordinary
  field is the first positional.

Nested and positional markers need no prohibition. Collections still refuse
the marker anywhere in a field's schema, because their reads return every field.
The app author keeps secrets out of returned, thrown, yielded, and nonlocal data.

## Consequences

The terminal prompt, character handling, test doubles, per-field argument
rules, schema keyword tables, and traversal state disappear. Headless setup
still works with JSON piped from a file or another process.

A person pastes a token into the app page. `--input -` is a stream, not a hidden
terminal prompt. Ordinary actions retain their flags, positionals, and JSON input.

A literal reserved marker in schema metadata also classifies the action as
confidential. In a collection field it is refused. Runtime input data is not
scanned for markers. This policy does not redact arbitrary action output.

## Considered alternatives

- Keep per-field confidentiality: preserves hidden prompting but also its
  acquisition branches and the need to recognize schema locations.
- HTTP only: removes the same terminal machinery but unnecessarily loses the
  existing JSON stdin path for scripts and headless setup.
- Refuse secret inputs entirely: removes the pasted-token UI or forces the
  same work into another endpoint.
- Restrict all fields to a new flat schema language: sacrifices ordinary
  TypeBox composition to solve the narrower credential problem.
