# Two App Archetypes, and Modernizing Skills as the First Export App

**Date**: 2026-06-02
**Status**: Draft
**Owner**: Braden
**Companion to**: `20260602T200000-vault-read-only-projection-agent-mutation.md` (PR #1895). This spec adds the archetype distinction that spec implied but did not name, then plans `apps/skills` + `@epicenter/skills` against it.

## One Sentence

Epicenter has two app archetypes, not one: a **Vault App** owns data that Yjs projects read-only into the vault's hardcoded `apps/<name>/`, while a **Library + Export App** curates a library that is rendered on demand into foreign tools' own directories; `skills` is the first Library + Export App, the 200000 spec's vault model does not apply to it, and most of its machinery already exists and just needs a consumer.

## How to read this spec

```txt
Read first:
  One Sentence
  Part 1: The Two Archetypes
  Part 2: Where Skills Stands Today

Decide these:
  Open Questions (the persistence/sync gap is the real one)

Read if implementing:
  Part 3: Modernization Plan
```

---

# Part 1: The Two Archetypes (addendum to 200000)

The 200000 spec collapsed the mount factories to a hardcoded `apps/<name>` and removed the freeform path knob, calling a freeform `markdownDir` "a data-loss foot-gun." That is correct **for vault apps**. But the same spec also *kept* the freeform `dir` on the `attachMarkdownExport` primitive, for "a non-vault export (a published blog writing `content/posts/`)." That carve-out was never named. Naming it resolves the skills question.

## The distinction

```txt
VAULT APP                            LIBRARY + EXPORT APP
(fuji, tab-manager, honeycrisp)      (skills, and the blog export)

data LIVES in your vault             data is a curated LIBRARY
projected READ-ONLY to apps/<name>/  RENDERED into a foreign tool's own dir
location is part of what the         location IS the product operation
  vault IS  ->  hardcoded, no knob     (".agents/skills", "content/posts")
ONE target, your machine, you browse MANY targets, any machine, a TOOL reads
mutate via `epicenter run`           publish via an explicit export action
```

The two look like they share "materialize markdown to a directory," but they split on a single axis: **who authors the target directory.**

```txt
apps/fuji/        the vault authors it     -> rebuild-overwrite is the contract
.agents/skills/   a TOOL consumes it       -> rebuild-overwrite is also correct
journal/          YOU author it            -> rebuild-overwrite is data loss  (the foot-gun)
```

A vault app must never reach `journal/`, so its target is a constant. An export app's target is *supposed* to be a foreign consumption dir, so a freeform target is correct there. Same knob, opposite verdict, because one names a real product operation ("publish my skills to Claude Code") and the other does not ("move markdown off apps/").

## Why a freeform target is SAFE on an export app

The 200000 foot-gun had two properties at once: it was a **persistent config** that a **continuous rebuild loop** unlinked. Remove either property and the knob is safe:

```txt
SAFE when:    the export is EXPLICIT (you invoke it; nothing watches and unlinks), AND
              the target is a tool-owned consumption dir (named, ideally, not raw-typed)

DANGEROUS when:  a persistent `dir` config that a materializer rebuilds on a loop, AND
                 it accepts any path, so it can point at something you authored
```

So the export app's target is exposed as an **explicit action with a named target**, never a daemon mount that watches a foreign dir.

## Named targets, not raw paths

The freeform `dir` stays as the underlying primitive (the flexible layer), but the product surface is a small set of named tool adapters:

```txt
epicenter skills export --to claude     ->  .claude/skills/   (agentskills.io layout)
epicenter skills export --to agents     ->  .agents/skills/
epicenter skills export --to cursor     ->  .cursor/rules/    (when an adapter exists)
epicenter skills export --to ./somedir  ->  raw path, the escape hatch (you typed it)
```

A named target resolves to a known directory and a known per-tool format. The raw-path form stays as the documented escape hatch, the way "store a URL" is the escape hatch elsewhere in the codebase. The default product path cannot be a mistyped destructive path.

## This validates 200000, it does not contradict it

```txt
200000 Open Question 4:  "If a one-shot bulk import is ever needed, build it as an
                          explicit user-invoked action, not an automatic watcher."

skills `import_from_disk`:  exactly that. an explicit action. NOT a watcher.

200000 kept attachMarkdownExport's freeform `dir` for non-vault exports.

skills `export_to_disk`:  exactly that. a one-way publish into a foreign dir.
```

Skills is not an exception to the 200000 model. It is the proof that the model needed a second archetype, and that archetype is already half-built.

## Decision

```txt
Add the archetype as a named concept:

  Vault App   -> read-only projection into apps/<name>/   (hardcoded, no knob)   [200000]
  Export App  -> explicit render into NAMED foreign targets, raw-path escape hatch,
                 built on attachMarkdownExport / a bespoke exporter, invoked, never watched.

`skills` is the first Export App. The blog export is the second.
An Export App does NOT get a `project.ts` vault mount and does NOT materialize to apps/.
```

---

# Part 2: Where Skills Stands Today (verified)

Skills is already split into a published package plus a browser app. The export archetype is **already implemented** and has **zero consumers**, mirroring 200000's note that `export.ts` had no consumers before that PR.

```txt
packages/skills/  (@epicenter/skills, v0.1.0, published: keywords, homepage, repo.directory)
├── src/index.ts         "." export: createSkills, tables, createSkillsActions, guid helpers
├── src/node.ts          "./node" export: openSkillsNode + import_from_disk + export_to_disk
├── src/workspace.ts     createSkills({ workspaceId }): iso doc, tables only, NO actions
├── src/tables.ts        skillsTable, referencesTable
├── src/skills-actions.ts createSkillsActions({ tables, readInstructions, readReference })
├── src/serialize.ts     serializeSkillMd  (Yjs -> SKILL.md)        [export direction]
├── src/parse.ts         parseSkillMd      (SKILL.md -> Yjs)        [import direction]
├── src/skill-instructions-docs.ts / reference-content-docs.ts   child-doc guid derivation
└── src/constants.ts     SKILLS_WORKSPACE_ID

apps/skills/  (browser-only SvelteKit SPA, ssr=false)
└── src/lib/skills/
    ├── index.ts    re-exports createSkills from the package (thin pass-through)
    ├── browser.ts  openSkillsBrowser(): iso + IndexedDB + BroadcastChannel + child-doc caches + read actions
    └── client.ts   module singleton:  export const skills = openSkillsBrowser()
```

What `openSkillsNode` already does (`packages/skills/src/node.ts`):

```txt
export_to_disk({ dir })   "one-way publish step": writes dir/<name>/SKILL.md + references/,
                          cleans up stale skill dirs (rm). Folder-per-skill, agentskills.io layout.
import_from_disk({ dir })  reads dir/*/SKILL.md, upserts rows, GENERATES + writes-back stable ids,
                           derives deterministic reference ids from skillId+filename.
```

This is the archetype, exactly as Part 1 describes it. The work is not to build it. It is to (a) give it a consumer, (b) resolve where the node side gets its data, and (c) align composition with the conventions.

## The conventions skills already meets, and the ones it misses

```txt
MEETS:
  iso factory createSkills is the package "." export                         ✓
  browser factory named openSkillsBrowser                                    ✓
  Shape B (module singleton, no auth gating)                                 ✓
  export/import are EXPLICIT actions, not watchers (matches 200000)          ✓
  freeform `dir` on the action layer, not on a vault mount                   ✓

MISSES:
  singleton lives in client.ts; convention is src/lib/session.ts            (even Shape B opensidian uses session.ts)
  apps/skills/src/lib/skills/index.ts is a thin re-export with no callers    (collapse it)
  createSkills returns NO actions; read actions layered separately           (defensible: env-bound readers, but document it)
  no `./browser` package export though the editor may be embeddable          (decide; opensidian exports ./browser for a real consumer)
```

## The blocker the grounding surfaced

`openSkillsNode` opens a workspace with **no IndexedDB, no relay, no persistence**. So `export_to_disk` on a fresh `openSkillsNode` reads an **empty library** and would write nothing (or clean up everything). The export logic is done; **the node side has no source of data.** This is the real open question, see below. The browser app has the data (IndexedDB); the node entry does not.

---

# Part 3: Modernization Plan

Ordered so each phase is independently shippable. Phases 1 and 2 are pure cleanup and can land before #1895 merges (skills does not depend on `appsMarkdownPath`, since it never materializes to `apps/`). Phase 3 is the real design work.

## Phase 0: Write the archetype down (this spec)

- [ ] **0.1** Land Part 1 as the named archetype. When #1895 merges, add a one-line pointer from the 200000 Decisions Log to this spec ("Export App archetype: see 210000").

## Phase 1: Composition alignment (no behavior change)

- [ ] **1.1** Rename `apps/skills/src/lib/skills/client.ts` -> `src/lib/session.ts` (Shape B singleton home, matches opensidian). Update the import in `+layout`/components.
- [ ] **1.2** Delete the thin `apps/skills/src/lib/skills/index.ts` re-export; import `createSkills` from `@epicenter/skills` at the one call site in `browser.ts`.
- [ ] **1.3** Add a one-line `@fileoverview` to `workspace.ts` noting `createSkills` intentionally returns no actions (read actions are env-bound via `createSkillsActions`, so they are layered in `browser.ts` / `openSkillsNode`).
- [ ] **1.4** Gate: `bun run -F skills typecheck` and `bun run -F @epicenter/skills typecheck`.

## Phase 2: Named-target export adapters (product surface over the existing action)

The action layer already takes a freeform `dir`. This phase adds the named-tool layer from Part 1 on top, without touching the I/O.

- [ ] **2.1** Add a tiny `targets.ts` in `packages/skills`: a map from tool name (`claude`, `agents`) to `{ dir, layout }`. Start with the two that exist in-repo (`.claude/skills`, `.agents/skills`); both are agentskills.io layout today, so `layout` is one value for now (do NOT invent per-tool format divergence before a tool actually needs it).
- [ ] **2.2** Keep `export_to_disk({ dir })` / `import_from_disk({ dir })` as the primitives (raw-path escape hatch). The named targets resolve to a `dir` and call through.
- [ ] **2.3** Document in the package README: named target is the product path, raw `dir` is the escape hatch, export is one-way and explicit, never a watcher.

## Phase 3: Give the export a consumer (the real work)

Two consumers are possible. They are not mutually exclusive; the browser one is simpler and matches "browser-based editor," the CLI one serves agents/automation but needs the persistence answer.

### Option 3A: Browser "Export to folder" (File System Access API)

The browser already holds the library in IndexedDB. The browser can write to a chosen directory via `showDirectoryPicker()`. No daemon, no relay, no node persistence needed.

```txt
editor  ->  "Export skills to folder" button  ->  showDirectoryPicker()  ->  write SKILL.md tree
        (reuses serializeSkillMd; reimplement the tiny fs walk against FileSystemDirectoryHandle)
```

- [ ] **3A.1** A `browser-export.ts` that mirrors `export_to_disk`'s structure against `FileSystemDirectoryHandle` instead of `node:fs`. Reuse `serializeSkillMd` verbatim.
- [ ] **3A.2** A button in the editor; pick a dir; write; toast on done. Chromium-only API, so gate the button on `'showDirectoryPicker' in window`.
- Trade-off: human-in-the-loop only (you click and pick), which is exactly right for the human path and sidesteps every persistence question.

### Option 3B: CLI `epicenter skills export/import` (openSkillsNode)

For agents and automation. Blocked on the persistence question below.

```txt
epicenter skills export --to agents   ->  openSkillsNode(...)  ->  export_to_disk({ dir: .agents/skills })
                                              ^^^ where does this workspace's data come from?
```

- [ ] **3B.1** RESOLVE: node-side persistence/sync (Open Question 1). Until then, `openSkillsNode` reads an empty doc and the command is inert (or worse, `export_to_disk` cleans up real dirs against an empty library).
- [ ] **3B.2** Once resolved, a thin CLI command (or `epicenter run` against a registered skills workspace) that opens the persisted/synced node workspace and calls the named-target export.
- [ ] **3B.3** Safety: `export_to_disk` currently `rm`s stale dirs. Against an empty library that deletes everything in the target. Add a guard: refuse to export when the library is empty unless `--allow-empty` is passed.

## Phase 4: Bootstrap the existing skills (one-shot import)

- [ ] **4.1** Run `import_from_disk({ dir: '.agents/skills' })` once to seed the library from the 97 existing skills, letting it write stable ids back into each `SKILL.md`. This is the 200000-sanctioned one-shot import.
- [ ] **4.2** Note the drift: `.claude/skills` (94) and `.agents/skills` (97) currently differ. Import from ONE (`.agents/skills`, the larger), then `export_to_disk` to BOTH so they converge. After this, the library is the single source of truth and the two dirs are projections.

## Explicitly NOT doing

```txt
- NOT giving skills a project.ts vault mount or materializing to apps/skills/.
  Skills is an Export App, not a Vault App (Part 1). It renders into foreign tool dirs.
- NOT routing skills export through attachMarkdownExport. That primitive writes flat
  one-.md-per-row; skills needs folder-per-skill + references/ + id write-back. The bespoke
  openSkillsNode exporter is a legitimate second exporter, not a reinvention to collapse.
- NOT building a continuous disk<->Yjs watcher. Import and export stay explicit (200000).
- NOT inventing per-tool format divergence before a real consuming tool needs it.
```

---

## Open Questions

1. **Where does the node-side library get its data?** This is the blocker for the CLI path (3B). Candidates:
   - **Relay sync.** The browser editor syncs to the cloud relay; the CLI authenticates and pulls the same `SKILLS_WORKSPACE_ID` doc before exporting. Most "real" but needs auth + relay round-trip in the CLI.
   - **Local node persistence.** A node-side Yjs file (e.g. under `~/.epicenter/skills`) that both the CLI and (some) sync path share. Simpler offline, but then how does it get the browser's edits?
   - **Skip the CLI entirely for now.** Ship only 3A (browser FS Access export). The human picks a folder; agents read the resulting files. Defer 3B until an automation need is concrete.
   - Recommendation: ship **3A first** (unblocks the whole feature with zero persistence work), treat **3B/relay** as a follow-up once an agent-driven export need is real.

2. **Should `openSkillsBrowser` move into the package as `@epicenter/skills/browser`?** Only if a second consumer needs the bare browser factory (opensidian's precedent). If `apps/skills` is the only consumer, leave it in the app. Decide by naming the second consumer or not adding the export.

3. **One library, or per-repo libraries?** Today `SKILLS_WORKSPACE_ID` is a single global guid, so there is one skill library across all machines/repos. Is that the intent (one personal skill library you publish everywhere), or do some repos want their own curated set? The global-guid choice currently bakes in "one library." Confirm before the relay path makes it load-bearing.

## Success Criteria

- [ ] The archetype distinction (Vault App vs Export App) is written down and referenced from 200000.
- [ ] `apps/skills` composition matches the conventions (singleton in `session.ts`, no dead re-export).
- [ ] Named-target export exists over the existing freeform action; raw path remains the escape hatch.
- [ ] At least one export consumer ships (3A browser button), so a curated library actually reaches `.agents/skills`.
- [ ] The two on-disk skill dirs converge from the library (one-shot import, then export to both).
- [ ] `export_to_disk` refuses to nuke a target against an empty library.

## References

- `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` (PR #1895) - the vault archetype + the kept `attachMarkdownExport` carve-out this spec names.
- `packages/skills/src/node.ts` - `openSkillsNode`, `import_from_disk`, `export_to_disk` (the archetype, already built, no consumer).
- `packages/skills/src/{workspace,tables,skills-actions,serialize,parse}.ts` - iso factory + codec.
- `apps/skills/src/lib/skills/{browser,client,index}.ts` - the browser editor to align.
- `.claude/skills` (94) / `.agents/skills` (97) - the drifted on-disk dirs the library will converge.
