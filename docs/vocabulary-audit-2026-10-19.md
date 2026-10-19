# Vocabulary audit: October 17 to 19, 2026

The source snapshot contains **47 ADRs: 27 Accepted, 17 Superseded, and three Proposed**.
Dates are the records’ Date headers, inclusive of October 17, 18, and 19.
The inventory covers architecture nouns, meaningful noun phrases, file conventions,
and API/CLI terms. It groups spelling/plural variants and excludes incidental
English words and example app names. The 26 groups contain 351 distinct
term labels, including the chosen replacements; these are not 351 separate
concepts.

The maintained names are in [shared vocabulary](CONTEXT.md). This audit preserves
the vocabulary found before the cleanup, including retired names in historical
records. Its inventory is evidence, not a requirement to teach every term to a person.

## Recommended model

An app opens local data and supplies its read schemas. On disk the files live in
a folder; a web app uses its origin’s storage. Synchronization can connect the
data to a Git repository later. CLI check and query require root
epicenter.json in v1. Inference is independently authorized. The Epicenter desktop
app and its runner are deferred.

A schema is the JSON Schema for one row’s frontmatter. A schema file contains
a tables map of such schemas; it is not a single row schema or a repository
configuration file. Filename and location confer no authority.
A person obtains it separately, including from a registry, and explicitly
copies it to root epicenter.json for CLI use. Any folder can use such a
supported schema. A mismatch reports a diagnostic while source remains
available. Apps do not require or publish it.

## Full grouped inventory

| Family | Terms and variants | Treatment | Main sources |
| --- | --- | --- | --- |
| Product | Epicenter, platform, data layer, toolkit, convention, library, engine | Epicenter names the product. Toolkit describes its local capabilities. Library and engine are implementation roles. Retire Epicenter as a name for one person’s data. | [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [0627](adr/0627-every-change-to-the-data-model-is-checked-against-nine-principles.md), [0635](adr/0635-generic-desktop-data-tools-are-deferred.md) |
| Apps | app, application, program, tool, personal app, first-party app, third-party app, installed app, web app, browser app, desktop app, standalone app, native app | Use app with a runtime qualifier when consequential. Installed-app machinery is historical; independent apps remain. | [0586](adr/0586-you-open-a-folder-never-an-app.md), [0605](adr/0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [0614](adr/0614-a-browser-app-is-identified-by-its-origin.md), [0633](adr/0633-apps-open-local-data-before-connecting-services.md) |
| App files | website, static site, single-page app, page, source, bundle, build, artifact, assets, manifest, release | Keep literal build/runtime terms. A bundle or page is not the whole app or its data. | [0589](adr/0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [0598](adr/0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [0600](adr/0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md), [0605](adr/0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) |
| Client roles | client, reader, writer, caller, person, agent | Roles, not extra products. App saves and direct agent writes retain different guarantees. | [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md), [0632](adr/0632-a-lens-belongs-to-its-reader.md) |
| Desktop UI | generic browser, generic editor, data browser, desktop data browser, folder viewer, file browser, text editor, Folders window, Settings, Home | Name the deferred product the Epicenter desktop app. File browsing and text editing are functions. Web browser names the runtime. Old window names do not imply delivery scope. | [0586](adr/0586-you-open-a-folder-never-an-app.md), [0587](adr/0587-epicenter-has-no-folder-of-its-own.md), [0601](adr/0601-the-generic-editor-edits-a-files-text-so-a-row-is-repaired-there.md), [0635](adr/0635-generic-desktop-data-tools-are-deferred.md) |
| Native execution | runner, local app runner, personal-tool runner, launcher, shell, host, window, WebView, iframe, native service, native capability, page API, bridge, IPC command | Runner is a deferred capability. Qualify runtime, shell, Git host, and inference provider. The old universal app host is retired. | [0581](adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [0596](adr/0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [0605](adr/0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [0635](adr/0635-generic-desktop-data-tools-are-deferred.md) |
| Local data | local data, local dataset, dataset, data folder, folder, directory, own folder, application folder, Epicenter folder, folder scope | Keep local dataset for independent local identity. Local data is ordinary prose. Folder/directory is a filesystem location; own-folder publication and scope-as-data-identity retire. | [0583](adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md), [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0586](adr/0586-you-open-a-folder-never-an-app.md), [0633](adr/0633-apps-open-local-data-before-connecting-services.md) |
| Git copies | repository, hosted repository, data repository, app repository, local copy, clone, disk clone, browser clone, replica, fork, upstream | Repository is Git. A clone is an independent copy. Data/app repository describes contents. Replica remains precise technical vocabulary when needed, not a product tier. | [0589](adr/0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [0605](adr/0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [0612](adr/0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [0623](adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) |
| Files and rows | table, row, record, row folder, row directory, attachment folder, file, path, root, stem, id, field, property, key, value, frontmatter, body, source, raw fields, reference, relative path | Keep table/row/field/body/file/path. Use row id for the address within a table and row directory for its associated files. Preserve existing record-reference IDs. | [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0608](adr/0608-apps-never-talk-to-each-other-they-share-paths.md), [0613](adr/0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md) |
| Interpretation | lens, description, declaration, definition, shape, schema, read schema, table schema, field schema, JSON Schema, editor hint, projection, view | Use schema for expectations, schema file for their selected envelope. Keep view for presentation and projection for derived query data. Definition remains a legacy source type. | [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0585](adr/0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [0613](adr/0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [0632](adr/0632-a-lens-belongs-to-its-reader.md) |
| Schema artifacts | schema file, epicenter.json, table.json, epicenter.ts, $schema, template, template branch, template commit, template history, publisher, schema publication, registry, catalog | Root epicenter.json is a CLI interpretation convention, not data identity. A schema file maps names to frontmatter schemas. Template ancestry, owning-app publication, and marker files are retired. Registry acquisition explicitly copies schemas into the folder; its implementation remains unbuilt. | [0585](adr/0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [0589](adr/0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [0609](adr/0609-a-new-data-folder-copies-its-apps-template-once.md), [0632](adr/0632-a-lens-belongs-to-its-reader.md) |
| Diagnostics | validity, conformance, issue, diagnostic, invalid row, malformed row, unreadable row, mismatch, containment, repair, refusal, finding | Name the criterion: schema issue, parse failure, or storage failure. Conformance issues do not erase raw values or universally refuse saves. | [0583](adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md), [0601](adr/0601-the-generic-editor-edits-a-files-text-so-a-row-is-repaired-there.md), [0613](adr/0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md) |
| Queries | query, SQL, column, query projection, SQLite database, typed table, grid, raw grid | Preserve these technical roles. Selected schemas supply expectations; schema-free SQL and automatic discovery are separate features. | [0608](adr/0608-apps-never-talk-to-each-other-they-share-paths.md), [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [0613](adr/0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [0632](adr/0632-a-lens-belongs-to-its-reader.md) |
| Editing | save, write, put, set, create, delete, move, rename, draft, unsaved input, edit, starting source, witness, from, sent, overwrite | Keep save, commit, and sync distinct. API verbs remain exact. Starting source and sent source preserve the draft’s causal context. | [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0622](adr/0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md), [0629](adr/0629-a-local-save-refuses-a-file-directory-replacement.md), [0630](adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md) |
| Git history | version, commit, history, branch, main, ref, head, base, Git object, blob, tree, object ID, oid, parent, ancestor, ancestry, shallow boundary, snapshot, checkpoint, candidate, index, working tree, checkout, pack, delta, merge driver | Use Git meanings. A snapshot is not all parent history; an operational revision is not a commit. Keep version as explanatory UI language when needed. No separate Epicenter checkpoint product. | [0591](adr/0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md), [0597](adr/0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md), [0619](adr/0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [0620](adr/0620-history-in-a-repository-only-grows.md), [0623](adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) |
| Merging | sync, fetch, push, rebase, merge, merge base, current, change, ours, theirs, winner, losing edit, merge unit, field merge, text region, diff3 region, insertion, conflict marker, conflict file, Overrode: trailer | Keep mechanisms and named roles; base/current/change replace competing winner labels. A save merge and Git merge commit are different operations. | [0591](adr/0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md), [0622](adr/0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) |
| Sync state | status, local, synced, pending, disconnected, stuck, unpushed, unsent edit, pending edit, pending commit, uncertain push, acknowledgement | Five app states include local. The old unpushed result is legacy. An exact pending commit and newer edits must remain distinct. | [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0624](adr/0624-a-repository-reports-synced-pending-disconnected-or-stuck.md), [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md), [0631](adr/0631-a-browser-observes-the-remote-before-making-a-commit.md), [0633](adr/0633-apps-open-local-data-before-connecting-services.md) |
| Storage | working file, working content, browser storage, IndexedDB, OPFS, database, object store, Git store, disk store, cache, meta, objects, edits, retained content | Keep qualified storage terms. Browser storage is not a physical folder. Unsent work is durable content, not a disposable cache. OPFS is the legacy implementation. | [0595](adr/0595-the-self-hosted-git-store-accepts-a-force-push.md), [0619](adr/0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [0623](adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) |
| Coordination | save lock, write lock, history lock, Git lock, mutex, publishing mutex, Web Lock, lease, owner, takeover, transaction, revision, publication, adoption, collection, retention | Mechanism names stay in implementation. Browser revisions/transactions replace planned lease ownership. Storage publication is distinct from retired schema publication. | [0581](adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md), [0619](adr/0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [0623](adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) |
| Addresses | remote, sync destination, destination, Git origin, web origin, address, URL, name, label, identity, local identity, repository ID, client_id, namespace, alias, registration, Connect, connection | Qualify values instead of merging identities. Namespace/alias routing retires. Connection is ordinary language; specify transport, destination, provider, or authorization when meaningful. | [0593](adr/0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md), [0612](adr/0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [0614](adr/0614-a-browser-app-is-identified-by-its-origin.md), [0633](adr/0633-apps-open-local-data-before-connecting-services.md) |
| Authorization | account, principal, owner, member, role, membership, access list, grant, repository grant, account grant, consent, target, scope, audience, token, access token, refresh token, session, credential, provider key, keychain | Retain precise security meanings. Local identity, hosted identity, authorization, and display names are not synonyms. | [0594](adr/0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md), [0606](adr/0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md), [0612](adr/0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [0614](adr/0614-a-browser-app-is-identified-by-its-origin.md), [0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md) |
| Services | deployment, hosted service, self-hosted deployment, installation, Git service, server, Git smart HTTP, resource, route, endpoint, API, credential helper, service connection | Use concrete service roles. Hosted Git, inference, runtime hosting, and provider configuration do not form one compulsory connection object. | [0593](adr/0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md), [0595](adr/0595-the-self-hosted-git-store-accepts-a-force-push.md), [0606](adr/0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md), [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md) |
| Inference | inference, transcription, AI service, provider, model, local model, model cache, endpoint, request, prompt, input, result, output, gateway, allowance, credit, usage, billing, plan, balance | Inference provider/configuration is independent of sync destination and repository permission. Keep the hosted allowance and billing responsibilities explicit. | [0596](adr/0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [0618](adr/0618-epicenter-hosts-no-ai-service.md), [0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md) |
| Media | recording, audio, attachment, blob, binary file, text file, LFS pointer, object store, local app storage, Trash | Qualify Git blob versus media bytes. Original audio stays local while text rows can sync. Managed attachment synchronization is deferred; Trash is a historical proposal. | [0592](adr/0592-a-folders-gitignore-decides-what-stays-on-one-machine.md), [0610](adr/0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md), [0621](adr/0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), [0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md) |
| Entry points | package entry point, executable entry point, export, opening function, opener, adapter, backend, storage port, handle, function, command | Use these as technical roles with qualifiers. Do not treat entry, opener, and handle as extra stored objects or invent exported APIs. | [0581](adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [0583](adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md), [0598](adr/0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md) |
| Legacy file conventions | epicenter.app.json, oauth-client.json, approvals.json, template-commit, .git, .gitignore, .gitattributes, info/attributes, refs/epicenter/publishing, refs/epicenter/builds | Keep actual Git conventions. Record former app-platform files as historical; their names do not require corresponding current product concepts. | [0586](adr/0586-you-open-a-folder-never-an-app.md), [0589](adr/0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [0597](adr/0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md), [0606](adr/0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md), [0619](adr/0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) |

## Distinctions retained

| Distinction | Why collapsing it would be misleading |
| --- | --- |
| Local dataset / hosted repository | Local work exists before sign-in and must survive connecting a different account or destination. |
| Repository / clone | Two web origins can share one remote while holding different saved local work. |
| Folder / browser storage | A disk editor can reach physical files; it cannot open another origin’s IndexedDB as a folder. |
| Table / directory | A directory becomes a table for the reader that names it; docs and scripts are not automatically typed tables. |
| Row id / file path / repository ID | Row abc addresses a row within a table and can be renamed. A path includes its directory; a hosted ID is stable across label changes. |
| Schema / schema file / view | A schema constrains frontmatter, a file supplies a map of schemas, and a view presents values. |
| Schema disagreement / parse failure | A string in a numeric field is still a readable value; broken YAML may require text repair. |
| Save / commit / push | A successful local save need not have a commit or a server receipt. |
| Draft’s sent source / merged result | Making unseen concurrent changes part of the draft’s base can cause the next save to erase them. |
| Web origin / Git remote origin | One is an OAuth/storage boundary; the other is Git configuration. |
| Grant / destination / provider | Inference permission does not select a repository; a Git URL does not grant access. |
| Cache / unsent edit | A cache is rebuildable; an unsent edit may be the only copy of acknowledged work. |

## Independent review

A fresh Codex reviewer and a read-only Claude Opus reviewer first developed
independent models from the outcome and current callers. Each then challenged
the concrete candidate. Both supported schema/schema file and rejected the
extra lens concept. Both found that operative bodies needed reconciliation,
not merely another glossary beside contradictory decisions.

Claude initially proposed folder for all local data, clone only as a verb,
and viewer for the deferred desktop client. The second pass withdrew those
proposals after checking browser storage, independent local identity, and the
delivery scope. Those substitutions would hide distinctions or introduce
another product name. Both reviewers retained exact current source symbols.

The cleanup does not rename the runtime API or stored fields. Current CLI help
and package exports were checked directly: the CLI still exposes auth login,
generate, save-version, and app commands; the data package’s public exports
are empty. Schema-file selection and the new opening API remain unbuilt.

## Changes classified

- Naming: schema replaces competing interpretation nouns; schema file names the
  existing tables-map envelope. Epicenter desktop app names the deferred client.
  Row id remains the table-local address. The stale P1 to P10 blanket rename
  plan is removed from 0584.
- Restating settled amendments: root/table markers, mandatory app association,
  namespace/name routing, owner-only access, JSON key merging, Web Lock leases,
  grant-gated local opening, and removal of hosted inference no longer appear
  as operative requirements of current decisions. Superseded bodies stay historical.
- Explicit reference scope: first-release record IDs stay unchanged. Automatic
  cross-repository navigation and the stored relative-path proposal in 0608
  are deferred. Literal Markdown links remain source, not permissions or a
  universal cross-device addressing guarantee.
- Repair responsibility: the deferred Epicenter desktop app is not a required
  source editor. Disk apps can identify their file locations for external repair;
  web apps need repair within their own origin. Parseable mismatched values stay
  visible beside an issue and can be edited.

## Work preserved as unresolved

The snapshot's three Proposed records remain Proposed: [0629](adr/0629-a-local-save-refuses-a-file-directory-replacement.md) covers occupied paths,
[0630](adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md) covers exact-byte starting content, and [0631](adr/0631-a-browser-observes-the-remote-before-making-a-commit.md) covers
first-remote observation. Code already implements parts of them, but naming
cleanup does not turn that evidence into acceptance.

Public local-opening signatures, native integration, first connection of local
work, schema-file CLI input, raw-grid UI, schema-free SQL, schema distribution,
and phone durability retain their implementation or product work.
No centralized schema registry, new reference encoding, or public API rename
is required by the vocabulary. The legacy vocabulary-check rules remain intact.

## Proposals added during the review

Four later Proposed records appeared in the shared checkout. They were outside
the 47-record snapshot and the independent reviewers' initial evidence. They
remain proposals, and this cleanup does not edit or accept them.

| ADR | Additional nouns and consequence |
| --- | --- |
| [0636](adr/0636-an-app-opens-local-files-through-one-folder-handle.md) | The proposed `Folder` handle names rooted file paths; a physical directory remains a separate runtime fact. The browser uses a default local selection, and a later runner selects at its own boundary. |
| [0637](adr/0637-whispering-keeps-desktop-audio-in-its-selected-directory.md) | Desktop audio belongs in the selected directory with its recording row. Browser audio remains app-owned storage, and generic folder writes remain text-only. |
| [0638](adr/0638-epicenter-mail-lives-at-mail-epicenter-so.md) | Epicenter Mail, maker endorsement, display name, application identifier, mail address. These distinguish a product's brand from its storage identity, browser origin, and deployment. They add no data-layer abstraction. |
| [0639](adr/0639-automatic-commits-refuse-new-non-text-content.md) | Epicenter-created commits refuse eligible new non-text content; existing Git commits and incoming objects still travel. This is separate from desktop audio placement. |

## Follow-up collapses

The product name is Epicenter desktop app. Host app and desktop host describe
its runtime role; launcher describes opening another app. Runner is a possible
capability of this same app. These names do not create separate deliverables.
The app README now uses the product name and labels the older installer as
existing implementation awaiting migration.

Repo is shorthand for repository. Use repository in developer explanations
about Git and retain exact command and endpoint spellings. App repository and
data repository describe contents, not different repository types. Product
text can ask a person to open a folder or choose where to sync.

Local dataset describes a local selection. It requires neither a public dataset
object nor a universal identifier and registry. Stable reopening must survive
account and remote changes. The earlier planned public `Repository` handle
name is withdrawn from ADR-0626 because local editing can precede Git; the
replacement public name remains proposed in ADR-0636. Existing internal source
names are unchanged.

Record can explain a row to a person without adding a second stored object.
Workspace adds no alias for opened data. Keep technical distinctions where
they determine access, storage, or save behavior, rather than replacing each
with another product noun.

## Parallel follow-up review

Three read-only Codex reviewers independently inspected documentation front
doors, recent ADR contracts, and actual app and library callers. The accepted
repairs remove remaining reader reconciliation rather than renaming live APIs:

- Root and package READMEs distinguish the implemented declaration-dependent
  APIs from the chosen optional-schema direction. The definition package no
  longer calls its helpers universal or treats a TypeScript row type as a lens.
  The desktop app's local agent guide routes architecture reading to those
  documents instead of repeating an old ADR index or linking a deleted package.
- The data package labels implemented proposals as Proposed. Engine comments
  separate local selection and handle lifetime from optional credentials and
  network work. The active integration spec uses schema-file terminology.
- Sync state keeps five values. Browser recovery needs an actionable cause
  and a route inside its own origin; a desktop CLI cannot inspect that database.
  The exact public diagnostic shape remains unbuilt. No closed error union or
  issue-list API is added.
- Local saves and commit prerequisites have separate owners. Three drifting
  exhaustive refusal lists are removed. A schema disagreement does not block
  a save; unresolved native Git conflict markers can still block a commit.
- The binary-write rationale respects bounded browser history rather than
  claiming every clone downloads every version forever. Text-only library
  writes remain the accepted contract; the later audio proposals remain Proposed.

Whispering's `Workspace` is retained: it owns session capabilities beyond its
folder. Replacing it with Folder would hide responsibility. The authored,
generated, and owner-published schema chain remains real migration work; a
terminology pass cannot remove it from working callers. Its eventual replacement
must prove schema-free file access and checking through the root schema file
without losing saved data or draft source.
Superseded [ADR-0527](adr/0527-a-data-folder-may-keep-its-declaration-as-typescript.md)
preserves the old `epicenter.ts → generate → epicenter.json` design. Its text
remains historical; the chosen design installs static JSON explicitly instead
of generating it from TypeScript.

## Final CLI convention

The owner chose root epicenter.json for v1 CLI check and query after the
review. This revises the earlier outside-the-folder recommendation. A person
obtains a schema independently and copies it into the folder. The commands
require it; apps, raw file access, and synchronization do not. Cloning a
committed copy restores that CLI interpretation. External-schema flags and
schema-free checking or SQL are deferred. Apps still never publish the file.

## Per-record coverage

This table enumerates every record in the dated snapshot, including historical
and Proposed records. Terms are selected from that snapshot; revised titles
do not change the citation number or source filename.

| ADR | Date | Status in snapshot | Principal noun families |
| --- | --- | --- | --- |
| [0581](adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) | 2026-10-17 | Superseded | storage port, shell command, scope, grant, IPC, save lock, staged file |
| [0583](adr/0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) | 2026-10-17 | Superseded | opener, definition, own folder, publication, containment, lens, scope |
| [0584](adr/0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) | 2026-10-17 | Accepted | app, folder, definition, row/stem, write, version/history, sync/remote, handle |
| [0585](adr/0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) | 2026-10-17 | Accepted | description, schema, app template, root marker, publication, definition |
| [0586](adr/0586-you-open-a-folder-never-an-app.md) | 2026-10-17 | Accepted | folder, launcher, app association, manifest, app ID, window, scope |
| [0587](adr/0587-epicenter-has-no-folder-of-its-own.md) | 2026-10-17 | Superseded | Epicenter folder, Settings, connection, keychain, local state |
| [0588](adr/0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) | 2026-10-17 | Superseded | installed app, approved commit, build, window, artifact, clone |
| [0589](adr/0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) | 2026-10-17 | Superseded | app address, repository, publisher, built files, manifest, template branch |
| [0590](adr/0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) | 2026-10-17 | Superseded | folder model, authority, principle, template, merge, data root |
| [0591](adr/0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) | 2026-10-17 | Accepted | content merge, extension, field, JSON key, region, merge driver |
| [0592](adr/0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) | 2026-10-17 | Accepted | ignore rule, local pattern, audio, binary, attribute, tracked file |
| [0593](adr/0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) | 2026-10-17 | Accepted | hosted repository, namespace, alias, name, rename, move |
| [0594](adr/0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) | 2026-10-17 | Accepted | account, namespace, token, membership, scope, hosted content |
| [0595](adr/0595-the-self-hosted-git-store-accepts-a-force-push.md) | 2026-10-17 | Superseded | self-hosted Git store, force push, branch, remote |
| [0596](adr/0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md) | 2026-10-17 | Superseded | native dictation, recorder, command, Cargo feature, native capability |
| [0597](adr/0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) | 2026-10-17 | Superseded | approved commit, bare clone, detached HEAD, approval registry |
| [0598](adr/0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md) | 2026-10-17 | Superseded | build, host, runtime, entry point, adapter, template history |
| [0600](adr/0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md) | 2026-10-17 | Superseded | approved commit, page, assets, window, built files |
| [0601](adr/0601-the-generic-editor-edits-a-files-text-so-a-row-is-repaired-there.md) | 2026-10-17 | Accepted | generic editor, row repair, source, file text, browser app |
| [0602](adr/0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md) | 2026-10-17 | Superseded | FolderApp, app address, manifest, folder ID, package entry |
| [0605](adr/0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) | 2026-10-17 | Superseded | single-page app, app source, fork, clone, build, upstream, installation |
| [0606](adr/0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) | 2026-10-17 | Accepted | origin, OAuth client, metadata document, callback, bearer route, cookie |
| [0607](adr/0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) | 2026-10-17 | Superseded | data folder, ID, scope, hand-off, browser origin, clone |
| [0608](adr/0608-apps-never-talk-to-each-other-they-share-paths.md) | 2026-10-17 | Accepted | shared paths, reference, relative path, sibling folder, root, resolver |
| [0609](adr/0609-a-new-data-folder-copies-its-apps-template-once.md) | 2026-10-18 | Superseded | template directory, first commit, app update, upstream, schema file |
| [0610](adr/0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md) | 2026-10-18 | Superseded | Trash, deletion, overwrite, source, Git history, recovery |
| [0611](adr/0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) | 2026-10-18 | Accepted | toolkit, CLI, library, Git service, data browser, runner, disk clone |
| [0612](adr/0612-a-repository-is-shared-by-the-people-on-its-access-list.md) | 2026-10-18 | Accepted | repository, stable ID, label, owner/member, namespace, membership, clone |
| [0613](adr/0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) | 2026-10-18 | Accepted | table, table.json, row, id, row directory, schema, frontmatter |
| [0614](adr/0614-a-browser-app-is-identified-by-its-origin.md) | 2026-10-18 | Accepted | web origin, client_id, grant, consent, account grant, token, callback |
| [0618](adr/0618-epicenter-hosts-no-ai-service.md) | 2026-10-19 | Superseded | inference, gateway, AI connection, credit, model cache, provider, key |
| [0619](adr/0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) | 2026-10-19 | Accepted | Git object, working file, access-list row, cache, metadata, publication |
| [0620](adr/0620-history-in-a-repository-only-grows.md) | 2026-10-19 | Accepted | history, fast-forward, revert, repository ID, branch |
| [0621](adr/0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) | 2026-10-19 | Accepted | text, binary, Git content, LFS pointer, audio, local app storage |
| [0622](adr/0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) | 2026-10-19 | Accepted | merge role, unit, field, region, losing edit, parent, trailer, save |
| [0623](adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) | 2026-10-19 | Accepted | origin, clone, IndexedDB, objects, refs, unsent edits, lease, snapshot |
| [0624](adr/0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) | 2026-10-19 | Accepted | status, synced/pending/disconnected/stuck, failure, schema, local |
| [0626](adr/0626-an-app-reaches-a-repository-only-through-open.md) | 2026-10-19 | Accepted | open, Repository handle, tables/files, Row, issues, from/sent, subscription |
| [0627](adr/0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) | 2026-10-19 | Accepted | data model, principle, repository, local dataset, schema, client, service |
| [0628](adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) | 2026-10-19 | Accepted | transaction, revision, B/C/E, boundary, pending commit, adoption, collection |
| [0629](adr/0629-a-local-save-refuses-a-file-directory-replacement.md) | 2026-10-19 | Proposed | local save, Occupied, draft, file-directory collision, witnessed deletion |
| [0630](adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md) | 2026-10-19 | Proposed | exact bytes, Blob, starting content, witness, from, deletion |
| [0631](adr/0631-a-browser-observes-the-remote-before-making-a-commit.md) | 2026-10-19 | Proposed | remoteKnown, observed remote, bootstrap, root commit, pending pair |
| [0632](adr/0632-a-lens-belongs-to-its-reader.md) | 2026-10-19 | Accepted | lens, reader, schema file, tables map, diagnostics, draft, explicit selection |
| [0633](adr/0633-apps-open-local-data-before-connecting-services.md) | 2026-10-19 | Accepted | local dataset, identity, connection, sync destination, repository ID, local state |
| [0634](adr/0634-hosted-inference-is-independent-of-repository-sync.md) | 2026-10-19 | Accepted | inference, provider, independent authorization, allowance, usage, billing |
| [0635](adr/0635-generic-desktop-data-tools-are-deferred.md) | 2026-10-19 | Accepted | Epicenter desktop app, runner, schema selection, generic browsing, native capability |
