# 0463. Completed SQLite query exports are deferred

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient folder query sessions; ADR-0501 removes store checkout and withdraws query export work.
- **Unbuilt:** SQL export has no implementation or caller and is not planned work. A future consumer must establish its own output contract.

## Context

The earlier proposal generated a completed SQLite snapshot from selected
Markdown, settings, and media references. It defaulted to `query.sqlite3` at an
explicitly chosen destination. It required standalone validation, failure-safe
publication, media selection, and public-data redaction. None of that shipped.

## Decision

**Do not implement or expose SQLite query export without a concrete consumer.**

Folder queries use transient in-memory projections. They require no saved
snapshot, default export filename, destination convention, or export generator.
The historical name `query.sqlite3` reserves no path in a live folder. Intentional
SQLite datasets remain ordinary authored files under normal source and Git rules.

A future SQL sharing feature must justify its need independently of internal
querying. It must define selection, schema, media references, and safe publication
at a caller-chosen destination. That is a new decision, not remaining work from
this proposal. Existing Markdown render/import and complete authored-file backups
are separate capabilities.

## Consequences

No exporter, public projection schema, SQL snapshot packaging, or publication
pipeline is needed for the first folder-query consumer. SQL sharing is unavailable
until a real consumer earns that work. Git preserves the earlier proposal.

## Considered alternatives

- Implement a standalone SQLite export now: adds an external schema and packaging
  contract without a reader.
- Save every query session as `query.sqlite3`: introduces persistence and freshness
  obligations when internal queries only need their captured projection.
