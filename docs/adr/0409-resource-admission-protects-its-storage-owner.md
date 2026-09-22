# 0409. Resource admission protects its storage owner

- **Status:** Proposed
- **Date:** 2026-09-18
- **Amends:** [ADR-0367](0367-library-erasure-requires-exclusive-ownership-of-all-local-resources.md) at unused whole-blob-store erasure and its locks; [ADR-0408](0408-one-app-opener-uses-a-complete-runtime.md) at aggregate admission and constructor-dependent memory storage.
- **Unbuilt:** Resource-specific admission for independent capabilities and removal of App-wide capability admission; Local and Personal already acquire separate document claims.

## Context

`openApp` claims an app-wide capability address and then acquires Local through
its own document claim. SQLite has a physical connection owner. Custom AI
catalogs already coordinate mutations across clients independently of App.
One aggregate claim does not describe those different protected resources.

## Decision

**Admission belongs to the resource whose concurrent ownership is unsafe.**

Local and Personal openers reserve their complete persistence address before
acquisition. Pending acquisition counts as ownership. A duplicate refuses with
`AlreadyOpen`; it does not wait, take over, or create a competing writer.
Retain established exclusion identities while old and new writers can coexist.
Renaming an API does not authorize renaming its lock or durable address.

SQLite retains its host connection registry, namespace ownership, statement
ordering, and operation drains. A browser SQLite owner closes its connections
and releases its pool before making that namespace available again. Recording
retains input-device admission and exact session identity through physical
teardown. Account-wide catalog mutations retain their own cross-context
coordination. Independent resource APIs do not remove these protections.

Remove the `app-capabilities` aggregate claim after every affected acquisition
path has the required resource owner, including evidence and test callers.
Do not copy that claim onto every capability. Blob publication retains atomic
no-overwrite writes; there is no whole-store eraser or per-operation Web Lock
merely because a blob handle has a lifetime. Secret access and stateless network
clients need no exclusive App reservation.

**Cleanup releases exclusion only after the protected resource is safe.**

Close fences new work immediately and drains admitted work. Failed physical
cleanup retains exclusion while another owner could race it. Failed opening
unwinds acquired resources and reports cleanup failure; it cannot release a
claim merely because no public handle was returned. Repeated close observes the
same terminal outcome. A late successful acquisition after owner loss is closed.
Page or process teardown is recovery, not evidence that pending writes survived.

**Test bindings isolate storage without simulating an entire application.**

A store test supplies store admission and persistence. A SQL test supplies its
SQL owner. Complete resource bindings never fill missing parts from production
services. IndexedDB receives a factory and the matching key-range constructor;
it does not replace globals or depend on constructor identity. Memory ownership
reserves synchronously and remains instance-local. Disposal refuses while an
opening, live, or failed-cleanup owner still holds resources.

Keep committed memory data separate from connection lifetime when testing
reopen. Closing a SQL handle rolls back unfinished transactions and removes
connection-local state without erasing committed data. No general shared,
exclusive, or queued lock simulator is required.

## Consequences

A local store no longer monopolizes unrelated inference or blob access. Each
exclusive boundary retains a concrete reason to refuse duplicates. Resource
owners replace aggregate admission without granting a second persistence writer.

## Considered alternatives

- One App claim: couples resources with different ownership addresses.
- One lock per public handle: serializes capabilities that already support
  concurrent use and hides the actual physical owner.
- Release on every failure: permits replacement while cleanup remains unsafe.
- Global fake IndexedDB constructors: makes independent tests interfere and
  preserves an avoidable implementation dependency.

## Verification

Exercise pending duplicates, failed opening, failed close, and immediate reopen
for each exclusive owner. Verify ordinary concurrent blob publication, SQLite
transaction isolation across reopen, independent input devices, and catalog
mutation coordination separately. No test may rely on an App claim to protect a
standalone acquisition path.
