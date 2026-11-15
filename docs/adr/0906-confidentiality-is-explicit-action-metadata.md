# 0906. Confidentiality is explicit action metadata

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Amended by:** [ADR-0907](0907-private-input-is-a-whole-call-handling-policy.md), renaming `confidential` to `privateInput` to state the scope of the policy.
- **Amends:** [ADR-0905](0905-secret-input-makes-the-whole-action-confidential.md), replacing `writeOnly` inference and reserved schema-marker rules. The whole-action policy remains.

## Context

Every policy consumer handles a whole action. Recovering its confidentiality
from schema content gives that action property another representation, with a
scan, field options, and restrictions on literal defaults and examples.
Messages' password form supplies its own presentation and needs none of those.

## Decision

Declare `confidential: true` on `defineAction`. It is Epicenter action metadata,
separate from input fields and MCP's tool annotations. An absent or false flag
means an ordinary action; a non-boolean value is refused at declaration.

```ts
defineAction({
  description: 'Connect Beeper',
  confidential: true,
  input: { token: field.text() },
  run: async ({ token }) => { /* validate and store locally */ },
});
```

MCP excludes and refuses confidential actions. HTTP accepts their JSON input;
the CLI accepts only `--input -`. Validation returns a fixed refusal, and commit
subjects omit all input values. JSON discovery preserves the flag at the action
level. Apps still own their returned, thrown, yielded, and persisted values.

Remove `field.text`'s `writeOnly` option, schema scanning, and collection marker
prohibitions. Raw TypeBox annotations pass through as schema data and never
imply confidentiality. Schema publication still requires finite JSON, checked
independently in action and collection declarations.

## Consequences

Each policy consumer reads `action.confidential === true`. There is no second
source of truth and no reservation on literal schema data. Authors classify
the whole action explicitly rather than marking a field.

Migrate existing confidential callers with the framework. An old helper option
may be accepted by the compiler and ignored at runtime; removing the scan before
migrating a caller would expose it as an ordinary action. Messages
moves its declaration to the action flag in the same change. Older runners
reject that new action key, so the migration fails closed before they upgrade.

## Considered alternatives

- Flag or schema marker: keeps two ways to express one policy and retains the
  scan, compatibility rules, and ambiguous metadata.
- Infer the flag once and cache it: hides the same inference behind another
  stored value without removing the field-level API.
- A separate setup registry: changes registration while preserving the same
  per-action policy; a direct property supplies the information already needed.
