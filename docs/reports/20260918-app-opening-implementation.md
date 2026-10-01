# Declaration and opening implementation

The application root is platform-free. Applications open through `openApp`;
SQLite consumers use `openData`; Bun tests retain `openMemory`.

```ts
import { defineApp, defineTable, field } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import { openData } from '@epicenter/app/data';
import { openMemory } from '@epicenter/app/memory';
```

These imports illustrate the separate consumers; application code normally
needs the first two. The [architecture map](../../packages/app/ARCHITECTURE.md)
contains source and runtime diagrams. [ADR-0407](../adr/0407-app-owns-the-declaration-and-data-engine.md)
records the accepted contract and amendments to the earlier opening decisions.

## Implementation

The baseline is `eb5f42f856`. The unrelated untracked integration report was
left untouched. No persisted address, document format, or sync frame changed.

- `defineApp` returns schema fields only. Runtime and AI overrides and the
  declaration's opening method are removed.
- Public `openApp(definition, account?)` selects this build's resources. Private
  `compose.ts` preserves the prior App lifetime body, readiness, retirement,
  retryable close, and ownership release.
- `openData(definition, sqlite)` borrows caller-owned SQLite. Disposing the
  returned document drains writes without closing the connection.
- `openMemory` retains fresh-record ownership and borrowed-record reopening.
  The general SQLite opener supports Worker and browser probes without Bun.
- The `/direct`, `/browser`, `/epicenter-host`, and `/store/browser` public
  subpaths are removed. `/store` exposes types, not construction internals.
- Historical browser generation helpers are removed. The current and local
  paths preserve their durable names. Old bytes remain untouched, and server
  startup still refuses to hide historical data behind an empty current library.
- Skills' dormant adapter uses current App opening; its route remains gated
  pending a product/auth decision. Five active tests replace three skipped
  tests of the old contract.
- Canonical declaration serialization is deleted. Malformed field serialization
  still returns schema errors, verified for cycles, bigint, symbols, and
  nonfinite numbers.

## Review

The [Claude consultation](20260918-data-opening-consultation.md), conducted
through the [consult-claude skill](../../.agents/skills/consult-claude/SKILL.md),
recommended the separate SQLite boundary and Bun convenience. Claude Fable 5.1
read a sealed snapshot and ran no runtime checks there. Codex verified the
recommendation against live callers and implemented it with bounded subagents.

An independent design review confirmed that the new boundaries earn their
place. It found one serialization-error regression after canonicalization was
removed; the field boundary was repaired and the reviewer confirmed the fix.
The reviewer verified the unchanged App lifetime body, record ownership,
current/local addresses, historical-data refusal, and Skills disposal ordering.
A separate source audit found no executable retired-API callers and verified
all 204 App package import literals against current exports.

## Validation

- Full repository `bun typecheck`: passes.
- App: 775 tests pass, including platform-free root bundles, type contracts,
  borrowed SQLite disposal/reopening, and malformed field descriptors.
- Server: 154 Bun tests and 32 real Worker tests pass, including historical-data
  refusal and current-generation behavior.
- Host: 200 tests pass, including application bundle builds.
- Migrated external callers: 57 focused tests pass; Chat, Skills data, and Local
  Mail schema tests also pass. Skills application: five active tests pass.
- Real browser storage reload: Chromium and WebKit pass, including rich text
  and namespace isolation. Recording smoke passes capture, decode, cancellation,
  reopening, and offline playback.
- Changed source lint/format checks and whitespace checks pass. Catalog,
  UI-boundary, boot-purity, and vocabulary guards pass.
- Engine TypeScript file list includes neither DOM libraries nor App platform
  implementations.

The App count decreases because tests exclusively promising removed historical
generation APIs were retired. Current durability, account isolation, ownership,
corrupt-read, rollback, and cleanup behavior retain active coverage. Two duplicate
App composition matrix cases were also removed after both paths converged.

The recording smoke fixture now includes the new opener in Vite's dependency
scan. Before that correction, late dependency optimization reloaded the page
during evaluation. The corrected fixture passes.

Repository-wide documentation hygiene remains at 56 existing findings, down
from 57 at baseline after accepting ADR-0407. The structure check still reports
ten historical dead paths and two hardcoded API paths, all within the baseline
failure set. Task-owned checks introduce no new failure. New files were included
through an alternate index when running path checks; unrelated work was excluded.
