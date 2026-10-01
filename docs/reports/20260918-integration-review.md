# Are we finishing the design, or patching around it?

Review date: 2026-09-18. Code baseline: `619afff3c5`.

This is a discussion document, not an approved implementation plan. It records the recent integration work and reconsiders what should happen next.

Concurrent work changed the checkout while this document was being written, including moving data code into `packages/app`. Findings and paths below describe the reviewed baseline. They must be checked against that ongoing work before becoming implementation tasks. This review did not author or validate those concurrent changes.

## Recommendation

Keep [PR #2507](https://github.com/EpicenterHQ/epicenter/pull/2507) as a draft checkpoint. Before merging, make the remaining startup contract consistent and demonstrate the actual Local Mail journey. Then build the saved-word and review loop in Vocab, the existing application that would become the broader Zhongwen experience.

Some recent fixes are band-aids. Others correctly repair dependencies, command names, and test environments. The concern is that we kept discovering and fixing failures without making the larger acceptance decision explicit. Passing those checks does not establish that this entire branch is coherent or that either application is useful end to end.

The original destination remains concrete:

> Read, search, and triage my Gmail locally. Then save Chinese words and return to them through review.

That should determine which infrastructure work is necessary.

## Evidence read

The review traced current application startup, the older browser startup API, the server import graph, and the changed verification surfaces. An independent read-only reviewer challenged the integration decisions. It did not rerun the tests.

<details>
<summary>Files inspected directly or through excerpts and diffs</summary>

```text
.agents/skills/
  design-review/SKILL.md
  radical-options/SKILL.md
  greenfield-clean-breaks/SKILL.md
  post-implementation-review/SKILL.md
  platform-seams/SKILL.md
  writing-voice/SKILL.md
AGENTS.md (also supplied in the conversation)
package.json
apps/
  epicenter/{AGENTS.md,README.md,package.json,scripts/install.ts}
  epicenter/src/applications.ts
  local-mail/{README.md,evidence/README.md}
  self-host/{runtime-profile.test.ts,worker/index.ts}
  skills/src/lib/application.ts
  skills/src/routes/+layout.svelte
  vocab/src/lib/practice.ts
packages/
  app/{README.md,package.json,src/open.ts,src/scopes.test.ts}
  data/{README.md,package.json,tsconfig.json,tsconfig.dom.json}
  data/evidence/library-ownership/device.ts
  data/src/store/{browser.ts,browser.test.ts}
  device/src/{owner.ts,owner.test.ts,library-claim.ts}
  server/{README.md,package.json,vitest.workers.config.ts}
  server/evidence/library-ownership/foundation.test.ts
  server/src/{index.ts,cloud-db.ts,create-cloud-context-middleware.ts,server-app.ts}
  server/src/db/{create-db.ts,backends/cloudflare.ts}
  server/src/routes/inference.ts
  server/src/store-sync/mount.ts
  server/workers/{entry.ts,selfhost.test.ts,initial-generation.test.ts}
docs/adr/
  0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md
  0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md
specs/
  20260909T004225-library-ownership-execution.md
  20260912T120000-app-composition-greenfield.md
```

</details>

## What I actually did

The work shifted from product planning to stabilizing a large existing branch. At this baseline the PR contains 221 commits and changes 1,145 files relative to `origin/main`. Most of that predates this integration pass. This is an architectural integration PR, not a small Local Mail feature PR.

| Step | Action and reason | What it establishes |
| --- | --- | --- |
| Preserve dirty work | Saved tracked changes and untracked files before reconciling them. | Recovery was possible; uncommitted did not mean disposable. |
| Reconcile the startup experiment | Restored three files that added initialization to the obsolete generation HTTP route family. Current startup already uses the current-library authority. | Avoided introducing another initialization path. Did not finish removing the older API. |
| Separate current behavior from proposals | Corrected guidance that described runtime platform selection and host-wide grants as already implemented. Kept the proposals as proposals. | Reduced misleading instructions without silently approving another architecture change. |
| Preserve evidence | Committed fixture repairs, benchmark evidence, and review checkpoints separately. | Made the retained work traceable. It did not make every historical test a current acceptance test. |
| Integrate main | Rehearsed the merge in a detached worktree, resolved conflicts, then merged main into the branch. | Preserved history and brought main's changes into the integration. |
| Repair the resulting failures | Fixed dependency resolution, a package lifecycle collision, Worker loading, typecheck placement, and a missing test dependency. | Made the exercised checks pass on the integrated state. |
| Push the result | Updated the draft PR. | Created a recoverable, shareable checkpoint. Merge readiness still needs judgment. |

The dirty files were mixed. Some were useful evidence and repairs; some asserted proposals as current facts; three extended an abandoned startup path. Treating them all as one commit would have hidden those differences.

The discarded startup experiment was never committed. Its original content was preserved under `/tmp/epicenter-pre-main-20260918/`, including `tracked.patch` and `untracked.tar.gz`. That is a temporary local backup, not a durable repository archive.

Two concurrent commits belonged to another task: `b8cbe49c00` isolated application module mocks, and `81f15b80c4` aligned inference/settings documentation. They were preserved rather than absorbed into my commits.

## Which changes are band-aids?

| Change | Judgment |
| --- | --- |
| Rename the desktop command from `install` to `app:install` | A durable correction. Bun interpreted the old name as a package installation hook. The rename removes that collision. |
| Declare SQLite as an App test dependency | A durable correction. The test imports it directly; an existing installation had hidden the missing declaration. |
| Put browser startup tests in the DOM typecheck leaf | Correct environment ownership. This is not evidence of an architecture problem by itself. |
| Preserve main's dependency versions after the merge | Necessary repair to my integration process. My first lockfile regeneration allowed unrelated upgrades. I corrected that instead of accepting them as incidental churn. |
| Force `pg-protocol` to its CommonJS entry in Worker tests | A contained workaround. It fixes the observed loader failure but deserves a removal condition. |
| Replace removed `sql.acquire()` calls with a public SQL operation | Valid API repair, limited evidence. The test still uses a fake physical SQLite owner and historical startup helpers. Its title promises more than it proves. |
| Correct documentation about unbuilt proposals | Useful repair, incomplete reconciliation. Other current-state descriptions remain stale. |

My process mistake was allowing “the next failing check” to become the next unit of work without restating what the complete result needed to prove. Those repairs were often necessary. Their accumulation was not an architectural verdict.

## The structural issue: two startup contracts remain visible

The intended path is already present:

```text
Application opens its App
  -> App owns the library lifetime
  -> data layer acquires the current library
  -> server authority chooses canonical initialization
```

But `packages/data/src/store/browser.ts` still exports older helpers such as `resolveGeneration`. Those helpers discover numbered generations and call HTTP routes that the server no longer mounts. Skills and an older durability fixture still contain consumers. Skills currently refuses boot, so this is an unfinished transition, not proof of a regression in a working application.

The stronger rule is: **an application opens its current library through the App; callers do not select remote history by listing generations.**

Finishing that rule could remove historical discovery/import startup helpers, unused route vocabulary, and fixtures that teach the abandoned contract. First migrate the durability evidence to current startup. Resolve Skills' intended behavior before changing its opener; “not currently usable” is not permission to discard that application.

This does not justify removing persistence protections. Keep atomic initialization, offline cache reopening, actor isolation, retirement fencing, and the server's explicit refusal to replace historical data with an empty library. Removing an obsolete API must not erase stored history or silently invent a migration.

This is a bounded completion of the existing design. The evidence does not call for another App lifecycle or a replacement storage framework.

## A second issue: shared imports reach hosted dependencies

The Worker workaround exposed this path:

```text
self-host Worker
  -> @epicenter/server root exports
  -> hosted database implementation
  -> pg
  -> pg-protocol loader failure
```

Self-host does not need to compose Postgres to encounter its module graph. The shared barrel exports hosted implementations at runtime.

A useful boundary would make hosted consumers explicitly import hosted implementations while keeping shared/self-host runtime imports independent of them. Prefer the existing package's export boundaries over introducing another package or dependency-injection system.

That could reduce unrelated dependencies and loader failures. It does not automatically remove the alias: tests that deliberately load hosted code might still need it. The removal test is concrete: inspect the resulting import graph and rerun the same Worker suite with the alias absent.

This is a follow-up candidate, not a reason to turn the Mail milestone into a server rewrite.

## Documentation is also partway through the transition

Separating ADR-0402/0403 from implemented behavior helped. It did not make every source agree. For example, supplied root guidance describes a literal `instance` self-host principal, while the Worker now resolves admitted users through `SELF_HOST_AUTH`. The composition spec's “Current state” still describes an older App shape.

Fix those statements at their owners. Code and package READMEs should explain today's contract. Proposals should describe a possible change. Dated reports should say what was inspected and tested. This report cannot substitute for that reconciliation.

## What the checks actually prove

The integration run used Bun 1.4.2. Recorded results include:

- Full repository typecheck passed.
- The selected application and launcher tests passed: 188 tests across 20 files.
- Worker tests passed: 32 tests across 8 files, with the `pg-protocol` alias.
- Browser/current-open data tests passed: 46 tests across 2 files.
- Installer tests passed: 4 tests.
- Local Mail browser journeys passed in Chromium and WebKit: 6 tests.
- Local Mail's production build passed with Vite 8.2.2.

Logs are local under `/tmp/epicenter-pre-main-20260918/`. These are results from the integration pass, not a fresh test run for this document. The whole repository test and lint suites were not run. GitHub mergeability is not equivalent to full CI approval.

The Mail browser tests use synthetic Gmail interactions. They do not prove a packaged desktop app can authorize a real account, restart, read offline, and later deliver queued triage changes. The repaired SQLite test exercises lazy ownership claims; its fake physical database does not prove persistence or physical release.

## What to build toward now

For Local Mail, the first useful version has a specific acceptance journey:

1. Connect a Gmail account and import mail with visible progress and recoverable failures.
2. Read and search imported mail, then restart the app and do both offline.
3. Archive, change read state, and apply supported triage actions locally.
4. Reconnect and verify the queued changes reach Gmail without disappearing or being duplicated after another restart.
5. Receive subsequent Gmail changes and show when the local view last synchronized.

Use this journey to find necessary infrastructure work. Sending mail, attachment workflows, a general plugin platform, and executing every proposed platform ADR need not enter this milestone.

For Zhongwen, start with the existing Vocab app and complete one learning loop: save a word with meaning and context, encounter it in review, reveal/check the answer, record the result, and return to it later. Existing generated practice passages are useful but do not establish that loop. Review history and scheduling need an explicit product decision. Host launchability also needs work; Vocab is not currently a launchable built-in desktop application.

The question to settle first is what review asks you to retrieve: meaning from Chinese, Chinese from meaning, pronunciation, or use in context. That choice determines the first review interaction and the data it needs. It does not require designing every possible study mode first.

## How I would structure the remaining work

Keep the current branch as the preserved integration checkpoint. Write a dependency map before attempting to split its 221 commits; splitting by folder alone could produce individually broken PRs.

Then use reviewable changes with explicit outcomes:

1. Finish the current startup contract and align its active callers, evidence, and current documentation. Preserve the data guarantees above.
2. Close and demonstrate the Local Mail desktop acceptance journey. Address dependency-boundary work here only where it blocks that result, or separately if it can stand alone.
3. Implement the saved-word review loop in Vocab with restart-persistent progress.

If the foundation cannot be separated safely, review it explicitly as a coordinated migration, with a map of removed contracts and retained guarantees. Do not describe the whole integration as “Local Mail support.”

The decision before merging is whether we can explain the new ownership model, show its callers consistently using it, and demonstrate the behavior it was built to support. Another passing test is useful evidence toward that decision. It cannot make the decision for us.
