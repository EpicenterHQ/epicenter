# 0925. An action's input on the command line is one JSON object

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), its rule that every field is a flag, at most one is positional, and `json`, `help`, and `version` are not field names; and [ADR-0907](0907-private-input-is-a-whole-call-handling-policy.md), only the spelling `--input -`, which becomes `-`.

## Context

An action's input is a JSON object described by JSON Schema. A page sends it
over HTTP and an agent sends it over MCP. The command line gives it two ways:
as flags and positional words that `inputFromArgs` rebuilds into the object
(`epicenter reading log 30 --book Dune`), or whole, as `--input '<json>'` or
`--input -` for stdin.

The first way is a second input language, and it has to be designed again for
every shape an input can take:

- It cannot give a list of numbers, an object, or the text `null` for a field
  that also takes `null`. Each already needs `--input`.
- Each action says which fields are positional, in `positional`, and the 12
  apps declare it 49 times.
- Because a field becomes a flag, no field may be named `json`, `help`, or
  `input`.
- An agent turns a field named `readingWas` into `--reading-was`, learns the
  positional order, repeats a flag for a list, and writes the word `null` to
  mean null. The schema it was given says none of that.
- About 250 of the 394 lines of `input.ts` exist only for it.

The second way already carries the cases that matter most. `routines.set`
stores `--input <json>`. An action with `privateInput` accepts only
`--input -`. One app's own instructions use `--input` because a reply holds a
newline.

## Decision

**`epicenter <app> <action> [<input>]`: after the action's words comes at most one more word, the input.**

`<input>` is one JSON object as text, or `-`, which reads that text from
stdin. No input means `{}`.

```sh
epicenter tasks add '{"title":"Call the bank"}'
epicenter reading finish '{"title":"Dune","rating":5}'
epicenter mail sync
epicenter messages suggest - <<'EOF'
{"chat":"<chat>","replies":["Ten works for me.","I'm on a call at ten."]}
EOF
```

| Given | Result |
| --- | --- |
| nothing | the input is `{}` |
| `-` | all of stdin is read as the JSON text |
| a JSON object and piped stdin | stdin is not read |
| text that is not JSON, or JSON that is not an object | refused, exit 2, with an example object |
| two or more words | refused, exit 2: the input is one argument |

Stdin is read only for `-`. A routine runs with stdin closed, and an agent's
shell may hold it open, so reading it unasked would refuse the first and hang
the second.

**The object is checked exactly as a page's or an agent's is.**

One `checkInput` serves all three, with the same messages. A key the action
does not take is refused, naming the keys it does take, so a mistyped key
never runs as if it were left out.

**An action with `privateInput` takes only `-`.**

An argument shows in the process list and in shell history. `-` is every
action's way to read stdin, so private input needs no spelling of its own.

**`positional` is removed from `defineAction`, and no field name is reserved.**

A definition that still has `positional` throws. `RESERVED_FIELDS` is
deleted. `--json` and `--help` stay the command's own options, read anywhere
before `--`, as for every command. A word after `--` counts as a word, so
`epicenter tasks add -- '{}'` is two and is refused.

**`--help` lists the keys and prints an example to copy. `--help --json` is unchanged.**

```txt
epicenter tasks add <input>
Add a task to do

Input, one JSON object, or - to read it from stdin:
  title  required  text. What to do
  due    optional  a day like 2026-11-12. The day it is due

Example:
  epicenter tasks add '{"title":"text"}'
```

The usage line ends `<input>` when a key is required, `[<input>]` when none
is, `-` for private input, and with nothing for an action that takes no
input. The example gives each required key a value its field takes: `"text"`,
a select's first choice, `2026-11-12` for a day, a number's minimum or `1`,
`true` for a switch. When no key is required it shows the first key. Private
input's example is a `- <<'EOF'` heredoc.

`--input` is removed: with one argument, the word has no job. A routine
stores its command as the action's words followed by the JSON.

## Consequences

- A person types more for a short call:
  `epicenter capture add 'Buy milk'` becomes
  `epicenter capture add '{"text":"Buy milk"}'`. Text with an apostrophe
  needs `'\''`, `'`, or `- <<'EOF'`.
- An agent copies the action's schema into one argument. For text a person
  wrote, it uses `- <<'EOF'`, which has no quoting to get wrong.
- Every new input shape, a list of objects or a nested object, works on the
  command line the day it works anywhere.
- A refusal names a key bare on every caller: `title is needed`, where the
  command line said `--title`. A key the action does not take is reported
  before a missing one, so a mistyped required key reads as the typo it is.
- The apps delete 49 `positional` lines. About 25 written commands in eight
  apps' READMEs, the package READMEs, and `docs/vision.md` change. Commands
  that pass no input do not.
- `inputFromArgs`, `flagOf`, `takesNull`, `choicesOf`, and the flag half of
  `usageLine` are deleted, with the checks on `positional` in
  `packages/app/src/action.ts`.
- JSON `null` and the text `"null"` are different values, so removing a field
  and storing the word need no special rule.
- A routine file written before this stores `--input`, which is then refused.
  The app's setup action is run again to rewrite it.
- [ADR-0867](0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md),
  still Proposed, describes the flag spelling. It is rewritten when this is
  built; its rule that `null` removes a field stands.
- This does not decide how a command line gives a file. It still refuses an
  action that needs one.

## Considered alternatives

- **Keep flags as a spelling of the same JSON.** One validator already serves
  both, and a short call is shorter. It keeps a second language to extend for
  every input shape, and the cases it cannot spell.
- **A bare word for an action with one text field.** Text that looks like
  JSON would be read as JSON.
- **JSON5, or `key=value` pairs.** A second grammar.
- **Read stdin whenever it is piped.** It refuses under a routine and can
  hang under an agent.
- **Keep `--input`.** Two spellings of one argument.
- **`@path` for a file of JSON.** The shell's `- < file` does it.
- **Ask for each field at the terminal.** A third surface; the app's page is
  the form.
