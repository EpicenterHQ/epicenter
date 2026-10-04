# Execution prompt: Vault as Read-Only Projection

Copy everything inside the fenced block below into a fresh agent session to execute the PR.
The authoritative plan is `specs/20260602T200000-vault-read-only-projection-agent-mutation.md`;
this prompt front-loads the rationale (reuse it in the PR description) and the exact mechanics.

````markdown
# Execute: Vault as Read-Only Projection (delete the bidirectional markdown subsystem)

You are implementing a fully-specified plan in the Epicenter monorepo. The authoritative spec is
`specs/20260602T200000-vault-read-only-projection-agent-mutation.md`. Read it end to end first.
This prompt closes every decision; you should not need to ask anything.

## What you are doing, in one sentence

Make app-materialized markdown a one-way, READ-ONLY projection of Yjs, mutated only through CLI
actions, and delete the entire bidirectional disk->Yjs reconcile subsystem. Bundle the config
hardening (hardcode the vault layout, remove freeform path options) into the same PR.

## Why (put this in the PR description)

1. Read-only projection. The body markdown codec is NOT a lossless fixed point on arbitrary
   hand-authored markdown (drops inline HTML except <u>, no table node, normalizes bullets), so
   treating a materialized file as editable truth can mangle a human's file on first flush.
   Merging an external edit into a live, concurrently-edited Yjs doc is unbuilt and races real
   CRDT ops. And coding agents have write tools, so editable files are a silent corruption vector.
   Refusing editability deletes all three problems at once: the asymmetric win. Adversarial review
   already confirmed the primitive choice (Y.Text, Y.Array tree, Y.XmlFragment) was never the
   lever; the editability decision was.

2. Vault layout A. Three content categories, three owners:
   - epicenter.config.ts  -> YOURS, root, tracked (like package.json)
   - apps/<name>/**.md     -> MACHINE, visible, gitignored (like dist/), read-only projection
   - .epicenter/           -> MACHINE, hidden, gitignored (like node_modules), sqlite/yjs/socket
   - journal/, ideas/, ... -> YOURS, root, tracked (like src/)
   Visible/hidden split axis: "does a human read this file directly as a file." Markdown is read
   by humans -> visible in apps/. SQLite is queried by machines -> hidden in .epicenter/sqlite/.
   One rule: read apps/** freely, never hand-edit it (regenerated, mutate via `epicenter run`),
   ignore .epicenter/, everything else is yours.

3. Hardcoded config, collapsed knobs. Config becomes `export default [ fuji(), tabManager() ]`.
   Mount factories ALWAYS materialize markdown to apps/<mount>; the freeform markdownDir/sqliteFile
   options are REMOVED. Reason: the export rebuild action does readdir + unlink-every-.md then
   rewrite, so a freeform `markdownDir: '../journal'` would turn a routine rebuild into deletion of
   hand-authored markdown. A convention cannot encode that invariant; a constant can. Flexibility
   stays on the `attachMarkdownExport` PRIMITIVE (a non-vault blog export legitimately targets
   content/posts/); the vault MOUNT FACTORIES are opinionated. A `{ projectionRoot, mounts }` object
   was rejected as overclaiming (sqlite is also a projection but lives elsewhere, so the name lies).

4. Gitignore the projection. apps/ is a regenerable cache; Yjs + the relay is the cross-machine
   sync layer, so git-tracking generated files only produces meaningless conflicts.

## This is TWO repos. Do not mix them.

- Monorepo (this worktree, branch already checked out): workspace lib, app migrations, deletions,
  doc sweep. THIS is the PR.
- Vault repo at ~/Code/vault (separate git repo; imports the monorepo source directly): folder
  moves, config simplification, .gitignore, AGENTS.md rewrite. Commit these IN ~/Code/vault, not in
  the monorepo PR. The two are coordinated: removing the factory options breaks the old vault config
  until it is updated to `fuji()`.

## Work in THIS worktree only

Do not read `/Users/braden/Code/epicenter/...` absolute paths; that is a different checkout on a
different branch with a stale file layout (e.g. a single `materializer.ts`). Use worktree-relative
paths. The real files are `vault.ts` / `export.ts` / `shared.ts`.

## Delete / keep / simplify (verified)

DELETE whole files:
  packages/workspace/src/document/materializer/markdown/vault.ts
  packages/workspace/src/document/materializer/markdown/vault.test.ts
  packages/workspace/src/document/materializer/markdown/apply.test.ts
  packages/workspace/src/document/materializer/markdown/reconcile-e2e.test.ts

KEEP untouched:
  .../markdown/export.ts  export.test.ts  git-autosave.ts  git.test.ts  slug-filename.ts

SIMPLIFY in place:
  .../markdown/shared.ts
     Remove the `protectLocalEdits` parameter and the dirty-guard block inside `writeRow` (the
     branch that reads the on-disk file and skips the write when it diverged). KEEP `fileState` and
     the `FileState` type: the rename-cleanup branch (unlink the previous filename) still needs it.
     KEEP materializeTable and rebuildTable.
  .../markdown/index.ts
     Drop the vault exports: attachMarkdownVault, ApplyPlan, MarkdownApplyError, MarkdownReadError,
     MarkdownVault, VaultTableConfig, VaultTablesConfig. Keep attachMarkdownExport, git-autosave,
     MarkdownShape.
  .../markdown/export.ts
     Rename the action `markdown_export_rebuild` -> `markdown_rebuild`. The export-specific name only
     existed to avoid colliding with vault's `markdown_rebuild`; once vault.ts is gone there is one
     seam, so use the plain name. Update the comment that explains the distinct key.
  packages/workspace/src/document/workspace-paths.ts
     ADD and export `appsMarkdownPath(projectDir, mountName)` -> `<projectDir>/apps/<mountName>`
     (from @epicenter/workspace/node). Do NOT flip or delete `markdownPath` (playground daemons still
     import it). Leave `yjsPath` and `sqlitePath` UNTOUCHED. Add a `workspace-paths.test.ts` case.
  apps/fuji/src/lib/workspace/project.ts
     Migrate attachMarkdownVault -> attachMarkdownExport. Move the body READ into the export's
     toMarkdown: `body: await readEntryBody(entry)` (readEntryBody uses serializeEntryBody). DELETE
     the import path: writeEntryBody/writeRoomOverHttp + parseEntryBody wiring and the per-table
     writeBody/onDelete callbacks. Remove the markdownDir/sqliteFile options from FujiMountOptions and
     the `resolveProjectPath(...) ?? ...` fallbacks. Materialize markdown via
     `appsMarkdownPath(projectDir, mount)`; let sqlite fall back to its guid-keyed `sqlitePath`
     default. DO NOT re-key yjs or sqlite (yjs is the durable source of truth resolved by
     `yjsPath(projectDir, ydoc.guid)`; re-keying orphans local data). Keep the `git` option.
  apps/fuji/src/lib/workspace/entry-body-markdown.ts
     Drop the parse half: parseEntryBody, createEntryBodyTokenizer, the MarkdownParser, and the
     markdown-it / prosemirror-markdown parser imports. KEEP serializeEntryBody, the
     MarkdownSerializer, and entry-body-schema.
  apps/fuji/src/lib/workspace/entry-body-markdown.test.ts
     Drop the parse / round-trip tests; keep the serialize tests.
  apps/honeycrisp/project.ts   apps/tab-manager/project.ts
     Same attacher swap + same option removal + same appsMarkdownPath wiring (simpler: no rich body).
  packages/cli/src/cli.ts
     Update the markdown example comment to `markdown_rebuild` (and drop the markdown_apply mention).

SWEEP (rg ALL of these; fix or remove each occurrence):
  attachMarkdownVault   markdown_apply   protectLocalEdits   parseEntryBody   writeBody
  ApplyPlan   MarkdownApplyError   MarkdownReadError   attachMarkdownMaterializer   markdownPath(
  markdown_export_rebuild
  Targets: packages/workspace/README.md, packages/workspace/src/document/README.md,
  .agents/skills/{workspace-api,attach-primitive}, docs/articles/one-sync-became-two-and-got-simpler.md
  (leave historical or note superseded), the three superseded specs (mark superseded).
  Playground note: playground/{tab-manager,opensidian}-e2e daemons import attachMarkdownMaterializer
  + markdownPath, NOT attachMarkdownVault. They are e2e scaffolds, not the product vault. Leave them
  on markdownPath (do not force apps/); do not delete markdownPath while they import it. If
  attachMarkdownMaterializer already fails to resolve, that is pre-existing and out of scope.

## Order of operations (migrate BEFORE delete; nothing may import vault.ts at delete time)

Commit incrementally, one logical change per commit, conventional-commit messages.

1. workspace-paths.ts: add appsMarkdownPath (+ test).                          [commit]
2. Migrate fuji/honeycrisp/tab-manager project.ts to attachMarkdownExport,
   remove the freeform path options, wire appsMarkdownPath.                    [commit]
3. entry-body-markdown.ts: drop the parse half.                               [commit]
   GATE: `bun run -F @epicenter/workspace typecheck` and the app typechecks pass.
4. Delete vault.ts + vault.test.ts + apply.test.ts + reconcile-e2e.test.ts;
   simplify shared.ts (drop protectLocalEdits + dirty guard, keep fileState);
   simplify index.ts (drop vault exports); rename markdown_export_rebuild ->
   markdown_rebuild in export.ts; trim entry-body-markdown.test.ts.           [commit]
   GATE: `bun test` in packages/workspace passes (export/git/materialize green).
5. Doc + skill + cli.ts sweep; mark superseded specs.                         [commit]

Then in ~/Code/vault (separate repo, separate commit(s)):
6. Create apps/; move fuji/ -> apps/fuji/, tab-manager/ -> apps/tab-manager/.
7. Delete stale generated dirs: old .epicenter/md/<guid>/ and old
   .epicenter/sqlite/fuji.db|tab-manager.db (regenerate on next daemon start).
   DO NOT touch .epicenter/yjs/ (source of truth).
8. Simplify config to `export default [ fuji(), tabManager() ]`.
9. .gitignore: ignore `.epicenter/` and `apps/`.
10. Rewrite AGENTS.md (+ CLAUDE.md shim): the one rule, the layout tree, the CLI discover/mutate
    recipe (`epicenter list --format json`, `epicenter run <mount>.<action> <json>`). Remove the
    soft-delete-by-hand guidance that referenced apply.

Final verification (local, against the vault):
11. Start the daemon; `epicenter list --format json` discovers actions;
    `epicenter run fuji.<update>` refreshes apps/fuji/*.md;
    hand-edit a file -> next materialize overwrites it cleanly, Yjs unchanged.

## Conventions (Epicenter, non-negotiable)

- bun only (bun run / bun test / bun x). Never npm/yarn/pnpm/node.
- Stage specific files only. Never `git add .` or `git add -A`.
- Conventional commits. No AI or tool attribution in commit messages.
- No em-dash or en-dash characters anywhere (source, markdown, comments, commit messages). Use a
  colon, comma, semicolon, parenthesis, or sentence break.
- Library code uses wellcrafted/logger, not console.* (CLIs/tests/benchmarks excepted).
- Do not delete identity/inference helpers (defineMount, defineActions, defineMutation, cmd,
  define*) without checking their overloads; their `return x` bodies thread type inference.
- Before final handoff/staging, load the `post-implementation-review` skill and do the second-read
  pass (touched-files tree, inline helpers, dead paths, stale imports, invariant owners, naming).
  Use `greenfield-clean-breaks` / `cohesive-clean-breaks` to justify any refusal.

## PR (monorepo only; the vault commit is separate)

Use the `pull-request` skill. Title: a clear refactor/feat describing the read-only projection clean
break. Body: the four-point rationale above (read-only, layout A, hardcoded config, gitignore), the
delete/keep/simplify summary, and the migrate-before-delete ordering. Do NOT add a Testing or
Verification section unless explicitly asked. Link the spec.

## Definition of done

- All three apps use attachMarkdownExport; vault.ts + apply/push subsystem deleted; shared.ts keeps
  only the one-way path; the rg sweep finds no stale references.
- `bun typecheck` and `bun test` pass; the daemon smoke test passes against ~/Code/vault.
- Config is `[ fuji(), tabManager() ]`; no freeform path options; the rebuild action (now
  `markdown_rebuild`) cannot reach a user zone.
- Vault: apps/ holds projections, .epicenter/ holds state, both gitignored; yjs untouched; AGENTS.md
  states the one rule and the CLI recipe.
````
