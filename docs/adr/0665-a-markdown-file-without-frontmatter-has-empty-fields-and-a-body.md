# 0665. A Markdown file without frontmatter has empty fields and a body

- **Status:** Proposed
- **Date:** 2026-10-21
- **Amends:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) at the `.md` merge unit: a headerless Markdown side also has empty fields and a body, rather than falling back solely because its fence is absent.
- **Implementation:** File and table reads, edits, listings and Markdown merges use one framing rule. The required/optional policy is removed from the codec and edit input. The decision remains Proposed.

## Context

`folder.files.edit(path)` treats a Markdown file without an opening `---`
frontmatter line as empty fields and body text. `folder.tables.<name>.edit(id)`
instead diagnoses the same bytes as missing required frontmatter. The
required/optional policy travels through the Markdown codec, pending input,
and both storage engines. Table lists and the CLI also parse rows separately.
Two handles of one path can therefore give different document answers even
though they share one source and one schema-independent save.

## Decision

**Every Folder entrypoint interprets the same Markdown source by one framing rule.**
After an optional byte-order mark, a file whose first line is not an opening
`---` fence has `{ fields: {}, body: source text after the mark }`. Its `text`
remains the exact source, including the mark. A bound schema validates `{}`;
missing required fields are schema issues, not framing issues. Reading neither
adds a fence nor supplies schema defaults. `folder.tables.<name>` still binds a
table address and schema; its list, get, set and edit operations use this same
rule. CLI check and query use it too.

**A frontmatter opener makes the body available only after its closing fence is known.**
A closed header whose YAML cannot be interpreted exposes unavailable fields,
the exact source, and the body after the closing fence. An unclosed opener
exposes unavailable fields and an unavailable body, with the exact source
retained for repair.
A body change is refused while that boundary is unknown, including when an
outside writer creates the unclosed opener between preparation and a guarded
storage attempt. Failed input remains pending.

**Structured changes preserve the document's framing unless their content requires a fence.**
Changing only the body of a headerless file normally leaves it headerless.
Assigning a field adds a frontmatter fence without losing the body. If a new
headerless body would itself start with an opening `---` line, writing an empty
fence first preserves the body as body. Each body write is read back under the
same rule before it is accepted as the new source. The source byte-order mark
stays in `text`, outside the body.

**Markdown merging uses that interpretation for base, current and change.**
An absent fence alone does not turn a Markdown side into malformed text. Named
fields merge by field and known bodies merge by line region under ADR-0622;
malformed headers retain its repairable-text behavior. Neither a table schema
nor a table address chooses merge units.

## Consequences

- Delete the required/optional frontmatter parameter, `strictRow` distinction,
  duplicate interpretation caches, and framing policy carried through pending
  input and guarded writes. Rows and listings add identity around the common
  Markdown value.
- A headerless file can be a valid table row when its schema accepts `{}`. A
  schema requiring fields instead reports those fields as missing. Table and
  CLI callers that select a view by schema success must use this new result.
- A field assignment over a headerless file may add a fence during a guarded
  retry. An unclosed opener still blocks structured edits that need its
  unknown boundary. Exact text and recoverable failed input remain available.

## Considered alternatives

- **Keep required table framing.** It makes the same bytes mean different
  things to handles of one path and keeps policy in every edit and save.
- **Always add an empty fence to headerless files.** Reading would rewrite
  ordinary prose and make a schema view determine file formatting.
