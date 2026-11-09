# 0519. Row frontmatter is YAML every common reader reads identically

- **Status:** Accepted
- **Date:** 2026-10-11
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (the one writer)
- **Unbuilt:** a check that runs the cross-reader corpus in continuous integration, and readers beyond PyYAML and Ruby's Psych (Go `yaml.v2`, Java SnakeYAML) in that corpus.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

Row files are plain Markdown that people, other programs, and agents read
and edit. The folder wrote frontmatter as JSON flow style, every key and
string quoted, which was exact but hard to read. YAML has two versions in
use: our parser and some libraries read YAML 1.2, while PyYAML, Ruby's Psych,
Go's `yaml.v2`, and SnakeYAML read YAML 1.1, where `yes` is true, `off` is
false, dates become timestamps, and `1e-7` is a string.

The `yaml` package's writer with `compat: 'yaml-1.1'` looked like the answer
and was tried first. A 6,400-case corpus read back with PyYAML 6.0.3 and Psych
3.1.0 showed it was not: `compat` follows the YAML 1.1 specification, not its
readers. Psych reads `tRue` and `nUll` in any case and `1,000` as a number,
and refuses `:x`; PyYAML refuses a plain tab and `=`; both reject raw NEL,
line separators, DEL, and C1 controls.

## Decision

**The folder writes block-style YAML with its own emitter, plain only where
every common reader reads the same value, and parses with `yaml` in YAML 1.2
mode.**

- A string is plain only when it starts with a letter or `_`, holds only
  letters, digits, spaces, and `_ . , ' ( ) / -`, ends without a space, and
  is no boolean or null word in any case. Everything else is double-quoted,
  with explicit escapes for tab, controls, DEL, C1, U+2028, U+2029, U+FEFF,
  U+FFFE, and U+FFFF. Keys follow the same rule.
- A multi-line string is a literal block only when it holds no tab or special
  character, its first line starts with neither a space nor a line break, and
  it ends with at most one line break; otherwise it is quoted.
- Floats keep a decimal point (`1.0e-7`) and negative zero is `-0.0`.
- Declared keys come first in declared order, then other keys in UTF-16 code
  unit order, nested keys in that order too; empty collections are `[]` and
  `{}`. An `undefined` value in a mapping is an absent key.
- Every write parses its own text before returning and refuses rather than
  writes when the text does not read back as the row.

## Consequences

Row files read like hand-written frontmatter, and the same bytes mean the
same values to Python, Ruby, Go, and JavaScript tools and to agents. The bytes
depend only on our emitter, not on a library version. The first save of a
hand-edited row normalizes its comments, quoting, and key order.

Some strings that could be plain, such as `café ☕` or `a: b`, are quoted.

## Considered alternatives

- **Keep JSON flow style.** Exact and simple, but hard to read in the files
  people own.
- **The `yaml` writer with `compat: 'yaml-1.1'`.** Disagreed with real readers,
  and its output can change between library versions.
- **The `yaml` writer in YAML 1.2 mode.** Writes `note: yes` and dates plain,
  which YAML 1.1 readers misread.
- **js-yaml, gray-matter, Prettier, or a Rust or WASM YAML formatter.** None
  writes YAML 1.1-safe scalars from a value; the formatters take text and
  keep its quoting.

## Verification

Current serialization coverage lives in
[note/canonical.test.ts](../../packages/definition/src/note/canonical.test.ts).
The tests and manual corpus results below record verification at decision time.

`2c2cd06e3125:packages/folder/src/row-text.test.ts` and `canonical.test.ts` pin the format,
the case-varied and doubtful strings, multi-line rules, floats, negative zero,
key order with integer-like keys, and absent keys. The cross-reader corpus
was run by hand: every value read back identically in PyYAML 6.0.3 and Psych
3.1.0, except integers beyond the safe range and keys over YAML's
1,024-character implicit-key limit, which the writer refuses.
