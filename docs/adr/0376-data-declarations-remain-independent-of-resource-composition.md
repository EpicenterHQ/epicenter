# 0376. Data declarations remain independent of resource composition

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Product migration from aggregate App opening to independent capability composition.

## Context

`defineApp` already returns an inert schema, and Local and Personal can open
without App. The SDK no longer requires an aggregate App to acquire services. The target
store owns both its document and blob namespace; recording, SQL, secrets,
and inference remain independently constructed.

## Decision

**Declare data once, and compose capabilities only where a product uses them.**

Keep `defineApp({ id, title?, tables, kv })` as the existing declaration API.
Its literal inference, validation, and schema-only consumers remain. The name
is not a requirement to construct a live App. A rename to `defineStore` is not
needed to establish resource ownership and is not part of this change.

Stores take the definition and provide `tables`, `kv`, and `blobs`.
SQL and secret constructors take their namespace ID. Recording borrows
`local.blobs` from its destination store. Inference takes its
specific account, environment capability, or endpoint input. Importing the
schema opens none of these resources.

Product composition implements the independent resource direction in
[ADR-0423](0423-app-resources-open-as-independent-handles.md). A local tool can
open only SQL without a declaration. Blob access requires an opened store,
including document readiness, under ADR-0372; schema-free blob access is outside
the target public API. A product composition function owns
its startup rollback and asynchronous workflows without becoming a mandatory
SDK constructor.

## Consequences

Schema inspection, artifacts, tests, and live stores share inert declarations.
Local and Personal definitions may differ by workflow under ADR-0419.
Resource opening stops depending on unrelated schema fields. The package keeps
its name `@epicenter/app` and its inert root; the useful change is ownership,
not a second declaration constructor or package rename.

## Considered alternatives

- Pass the full definition to every opener: makes schema appear required where
  only an ID is used.
- Rename every symbol containing App: adds caller churn without changing what
  a declaration or package owns.
- Give declarations opening methods: pulls platform composition toward inert
  imports and creates a second opening surface.
