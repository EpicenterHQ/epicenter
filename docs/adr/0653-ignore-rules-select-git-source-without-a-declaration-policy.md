# 0653. Ignore rules select Git source without a declaration policy

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at its outside-repository audio placement and migration requirement: current folders can retain binary files locally, including ignored recordings, and the declaration policy is removed without migration. Its tracked-file and ignore semantics stand. [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) at text-only library writes: the files API saves text or bytes, while tables interpret Markdown.
- **Relates:** [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md) owns W/B/P storage and exact sending identity.
- **Unbuilt:** public browser sync attachment/scheduling.

## Context

Native history implemented a stronger declaration-owned exclusion than ordinary
Git ignore. It accumulated rules during operations, rejected weakening them,
scanned outgoing history, and blocked commits without an epicenter.json. Browser
synchronization committed its complete working tree and therefore had no way to
retain ignored local recordings while exchanging shared files.

The user chose ordinary Git semantics and a zero-user clean break. No migration
or stronger never-send privacy guarantee is required.

## Decision

Tracked files remain tracked. Untracked files enter a commit unless ignored.
Repository .gitignore files are captured with the candidate; native Git also
honors its ordinary global and info/exclude sources. Text and binary files use
the same eligibility rules. Ignore files merge as ordinary text. Finder files such as .DS_Store have no built-in exception; an ordinary ignore
rule can exclude them. There is no
Definition.local field, declaration policy reader, weakening check, history
privacy scan, or binary admission gate. Git operations require no declaration.

W retains all locally saved files. B records the incorporated remote snapshot.
P is the exact unsettled send. Browser preparation derives a send tree from W
using B's tracked membership. When reconciling an unsettled P, P supplies that
membership instead; it is never the union of B and P. Selection introduces no
persisted checkpoint, staging ledger, dirty map, or lifecycle flag.

Remote adoption restores ignored local additions over synchronized content.
An incoming file or directory that would occupy their paths is a visible
collision, including names that collide on disk. The local bytes remain
accessible through the files API. Existing W/B/P publication guards, exact
acknowledgement settlement, and operation-local captures protecting concurrent
collection remain. Editing ignore rules does not rewrite an exact P.

**An app maintains its required exclusions by editing an ordinary .gitignore.**
Whispering's startup behavior is to read the file, retain unrelated
rules, and compute the contents that include its current required directory
exclusions, initially /audio/. An app upgrade that adds another excluded
directory uses the same operation. Write only when the contents need changing,
passing the exact source read as files.write's from. The ordinary save engine
merges concurrent text edits and rejects stale publication candidates. A failed
read or save stays visible; the app does not claim the rules were installed.
A successful files.write acknowledges the merged file, not the requested text
verbatim. A caller requiring confirmation rereads and evaluates the resulting
rules; text merging alone does not establish their meaning. Whispering runs
this operation before its first product reads in both builds, using the context
FolderApp opened. Its
root-directory check uses the installed ignore parser rather than a literal
line search. Existing UTF-8 source, including its BOM and line endings, survives.
Invalid UTF-8 or NUL-containing source is left unchanged. An update failure
becomes a persistent app warning; Files remains available for repair, and
reload checks again. It adds no saved startup state or app-level retry loop.

The app maintains these exclusions rather than treating them as starter defaults.
Removing one can therefore cause the app to restore it on the next startup.
The update must respect Git's ordered rules and exceptions; literal presence of
a line alone does not establish an effective exclusion. Unrelated rules remain
source content rather than app settings. The initial contract adds or restores
required exclusions; it does not promise to identify and remove obsolete app
rules. There is no app-version ledger or declaration policy behind this update.

Missing .gitignore is valid for the folder engine. openFolder, Git initialization,
and clone remain passive with respect to ignore rules. App startup maintenance
is an ordinary files API caller, not a new opening option or a Git hook. A local
save does not make a commit; later commit or sync records the file normally.

An app can verify the exclusions in the file it last read; it cannot establish
a permanent exclusion guarantee. Other writers and later sync can change the
file again. Already-tracked files stay tracked, and an exact pending send
is not canceled by a new rule. No stronger never-send privacy policy returns.

## Consequences

- Deleting a rule can make untracked recordings eligible before an app restores
  it. Adding a rule does not untrack earlier files or purge history.
- A remote can change shared ignore rules. Already-tracked incoming content
  remains tracked; it is not censored by destination ignore rules.
- Preparation reads trees and ignore blobs, while ordinary local saves remain
  independent of Git policy. Other blob payloads are unnecessary for preparation.
- Native captured-rule evaluation copies ignore files into a temporary working
  tree and uses the actual Git directory for machine excludes. It adds file
  operations while avoiding a second native rules interpreter.
- The native engine still reads portable payloads before source selection, and
  the isomorphic-git transport still copies held objects through its temporary
  repository. This decision makes no latency or peak-memory claim.
- Path safety and Git-private-state protections retain their own responsibility.
  They are not privacy policy or user-configurable ignore defaults.

## Considered alternatives

- Retain an absolute local policy: preserves never-send guarantees but requires
  declaration readers, historical scans, weakening rules, and extra refusals.
- Refuse new binary files: introduces content classification, failure states,
  and an override flow in addition to ordinary ignore semantics.
- Seed exclusions only on creation: preserves user removal, but does not maintain
  exclusions introduced by app upgrades. Use this when rules are starter defaults.
- Infer first use from an empty audio directory: emptiness cannot establish
  whether an app may update rules. Startup maintenance has an explicit contract
  and does not depend on whether recordings exist.
- Replace the whole ignore file: discards unrelated rules and concurrent edits
  when the app only needs to add exclusions.
- Add a generic template or seed-aware sync protocol now: creates coordination
  without an actual consumer. App-maintained rules can remain ordinary content.
- Use only repository rules natively: gives portable selection, but silently
  ignores machine excludes that ordinary native Git users already rely on.
