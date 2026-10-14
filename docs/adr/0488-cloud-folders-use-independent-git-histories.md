# 0488. Cloud folders pair with independent private GitHub repositories

- **Status:** Proposed
- **Date:** 2026-10-02
- **Revised:** 2026-10-05: GitHub owns the initial remote repositories; Epicenter owns account connections and folder pairing.
- **Unbuilt:** GitHub App authorization, private repository creation, account pairing and discovery, captured-account Git credentials, browser transport, and multi-device folder acceptance. Real audio history remains a separate feasibility gate.

## Context

A file-authoritative data folder already stores ordinary files with Git history beside them. The current engine fetches, pushes, adopts clean fast-forwards, and in the browser merges diverged histories, against a loopback Git HTTP service in tests ([ADR-0474](0474-incoming-git-adoption-retains-a-recoverable-plan.md)). Epicenter Cloud instead synchronizes opaque Yjs update logs. It has no folder Git hosting or repository listing API.

A folder is a dataset, not an installed application. Several applications can open the same folder, and one application can open several folders. Local ownership locks, scans, and incoming adoption already operate on one directory. Account-wide Git would couple otherwise independent folders.

A folder name cannot also identify a reusable repository lifetime. In an isolated Git experiment, an old clone successfully pushed into an empty replacement repository at the old address. GitHub repository names and URLs can change or be reused, so a managed pairing must retain the repository ID independently of its current URL.

The user chose ordinary files, trusted hosting, and account-based recovery over a custom encrypted-folder system. A private GitHub repository supplies the remote without requiring Epicenter to operate Git storage. GitHub sign-in establishes identity; authorizing repository access is a separate action available to users of other sign-in providers too.

## Decision

**Each paired account folder has one private GitHub repository.** Its committed `main` tree is the cloud counterpart of `accounts/<account-key>/<folderId>/` in [ADR-0461](0461-an-account-directory-name-is-a-hash-of-the-exact-account-identity.md). An account-local folder can exist without a remote. One GitHub connection may serve several folder pairings, each with independent history. Local scope folders stay outside managed account publication.

**A folder ID names a dataset; the GitHub repository ID identifies the paired remote.** Folder IDs are unique within an account. A reverse-DNS name such as `so.epicenter.whispering` is the normal application default, not a globally unique repository identity. The same name can exist in Local and in several accounts. Repository names need not equal folder IDs:

```text
account A
  so.epicenter.notes       GitHub repository ID N, braden/epicenter-notes
  so.epicenter.whispering  GitHub repository ID W, braden/epicenter-whispering
```

Before issuing managed transfer credentials, resolve the paired repository ID and check current access and the requested destination. A deleted repository, replacement at the same name, changed owner, or mismatching origin must not silently retarget a folder. Tokens are restricted to the selected repository ID and required permissions. URL and permission races still need live evidence; a preflight check alone does not establish permanently retired URLs. Raw Git using separately configured credentials remains outside this managed guarantee.

Disconnecting GitHub or unlinking a folder does not delete the repository or local files. Revocation stops new credential issuance; already issued GitHub tokens have their own expiration and revocation behavior. Repository deletion and GitHub retention are separate operations and policies.

Managed folder IDs use two or more dot-separated lowercase ASCII labels, each beginning and ending with a letter or digit and containing only letters, digits, and interior hyphens. The complete name is at most 128 bytes. Exclude platform-reserved directory names, including Windows device basenames before the first dot: `con`, `prn`, `aux`, `nul`, `com1` through `com9`, and `lpt1` through `lpt9`. Creation and native setup enforce the same rule; no escaping, case folding, aliases, or silent renaming are introduced. Existing arbitrary paths and browser IDs are not automatically migrated into this managed namespace.

Standard `remote.origin.url` records a checkout's transfer destination. The server pairing retains the repository ID for discovery and authorization; no tracked identity file or special ancestry root is added. Discovery reports disagreement with an existing origin and never rewrites it. Matching names or URLs establish neither access permission nor shared history.

**Creation explicitly requests a private, empty repository.** Select `main` as the transfer branch and do not initialize a README, license, or unrelated seed history. Verify the returned repository's identity and visibility before pairing or uploading. Creating a repository transfers no folder content. Existing repositories are selected explicitly, checked for private visibility, and inspected before adoption. The first push publishes local history. A new device downloads existing history before editing when available.

**Epicenter owns connections and folder pairing; GitHub owns repositories.** Postgres associates an Epicenter principal with a verified GitHub identity, authorized installation, and folder-to-repository pairings. It does not mirror GitHub history or inventory every repository. One live pairing per account folder is enforced at the pairing boundary. Retry after uncertain repository creation must identify the result before creating another repository; a database transaction cannot make a GitHub API request atomic.

The dashboard manages the connection. An app may launch that flow and pair its own selected folder. Each app signs into the same Epicenter account with its own session, discovers available pairings, and explicitly downloads or links a folder. A GitHub installation on an organization does not grant every Epicenter user access to it. Check the requesting person's authority before creating repositories or releasing credentials. Personal-account acceptance comes first; organization support follows verified authorization behavior.

**Git owns history exchange.** Managed transfers use ordinary non-forced pushes and explicit fetch/adoption. Do not claim server-enforced protection from force pushes or branch deletion unless the repository's GitHub rules have been configured and verified. Other clients follow GitHub permissions and repository policy. Independent folders never need to merge their histories. Independently edited devices of the same folder may have unrelated roots or divergent commits. The explicit app Sync action in ADR-0489 combines clean histories, including unrelated roots, and exposes conflicts while retaining both versions. Linking an origin never establishes common ancestry or starts a transfer.

Cloud content is the committed `main` tree. Saved but uncommitted files, ignored files, and files absent from the selected commit are not cloud data. A complete current-folder backup must include saved files and materialized media beyond committed history. A separate server-side editing API is outside this decision.

**Authentication stays outside the folder.** Epicenter session credentials go only to the Epicenter service. The server keeps the GitHub App private key in deployment secret storage and obtains short-lived, repository-scoped GitHub tokens after access checks. Installation IDs and repository IDs are connection metadata, not credentials. If a workflow needs persistent user refresh tokens, encrypt them separately in Postgres with a key outside that database; do not add that lifecycle without a caller.

The transfer captures the account, pairing, and trusted GitHub destination. Neither Epicenter nor GitHub tokens appear in URLs, repository configuration, command arguments, or logs. Native delivery must withstand rewritten URLs, redirects, hostile helpers, and account replacement. Hooks and aliases remain user-executed code; do not give them the token through environment or arguments. Browser transport may require an authenticated proxy. If it does, Epicenter handles content in transit even though GitHub hosts the remote copy.

Private repositories use trusted-host access control, not operator-blind encryption. Local files remain readable and rely on device protections. No client folder key or encrypted Git representation is introduced.

## Feasibility gates

GitHub's [repository API](https://docs.github.com/en/rest/repos/repos) and
[installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
document creation and repository-scoped Git HTTP credentials. These establish
API capabilities, not the live Epicenter pairing journey.

- Exercise one designated development GitHub App and personal test account: authorize selected repositories, create privately, verify access to the newly created repository, and perform ordinary clone, fetch, and push.
- Verify account isolation, repository-ID checks after rename/delete/recreation, pairing uniqueness, uncertain creation retries, expired tokens, and revoked installation access. Test concurrent first pushes without claiming Epicenter controls GitHub's repository lifecycle.
- Establish a per-invocation native credential channel for the CLI and each standalone app, including hostile helper configuration and account replacement. Browser account storage also needs applications to select account-qualified OPFS directories and lock names, captured-account Git HTTP credentials, and CORS. None exists for hosted folders today. Origin-wide cookies or an unscoped authentication header do not satisfy the captured-account contract.
- Measure stored bytes and clone time with real Whispering audio history. No measurement exists. Shallow clones, partial clones, LFS, encryption, and history purge are not assumed.

### Earlier first-party hosting evidence

The [disposable hosting experiment](../../apps/api/evidence/folder-git-host/README.md) reproduced 134 passing checks on 2026-10-04 with Bun 1.3.14 and Apple Git 2.50.1. A small authenticated router, SQLite repository records, and native `git http-backend` serve ordinary Git clients. Five initial-push trials hold both native pre-receive hooks with distinct live parent processes before release; exactly one history wins and fsck passes. Fixture accounts are isolated. Retirement remains irreversible after an admitted push finishes and after the database is reopened. Scripted ID collisions preserve existing storage.

This supports a Git-capable disk host as an alternative without an application mutex or separate catalog. It is preserved evidence, not the next GitHub-first implementation wave or a production deployment. Authentication uses fixture bearers; real session resolution and captured-account credential delivery remain unproved. Database reopening is not an OS restart or crash test. Bodies are buffered, gzip was not observed, and browser transport, concurrent subsequent updates, multi-host lifecycle, byte purging, and real audio capacity remain outside the experiment. No Worker, Local origin, or application startup changed.

## Consequences

- Connecting GitHub once permits several independent folder pairings without operating Epicenter Git hosting.
- Repository IDs, not reusable URLs, anchor managed discovery and credential scope. GitHub lifecycle behavior must be verified before claiming replacement protection.
- A local folder whose origin differs from the current listing requires an explicit human decision. Discovery never rewrites it.
- Git computes ahead, behind, and divergence after fetch. Humans or coding agents resolve histories using Git; file meaning and schema validity still need checking after a merge.
- One folder's divergence does not block another folder. No commit spans folders, so cross-folder links can point into a sibling at an older revision.
- Full clones include committed audio history. GitHub file limits and growing binary history remain obstacles to shipping this path for Whispering recordings.
- Independent initial edits can create unrelated roots; ordinary later edits can diverge. Fast-forward refuses both as `Diverged`. A browser folder's `mergeIncoming()` merges diverged histories with exactly one merge base and refuses unrelated roots as `UnsupportedHistory`. Native explicit Git can join histories, including `--allow-unrelated-histories` when needed; an unrelated root need not imply a conflicting file.

## Considered alternatives

- **Operate Epicenter Git hosting first.** The local experiment supports feasibility but retains hosting, storage, backup, supervision, and lifecycle work that GitHub can own. Keep its evidence; defer production rollout while proving GitHub pairing.
- **One account-wide repository or one repository per application.** Both couple datasets beyond the directory ownership boundary. Applications and datasets do not map one-to-one. Use one repository per paired folder.
- **Treat GitHub login as repository authorization.** Identity-only login must not silently grant content access. Connect GitHub separately, including for people using another sign-in provider.
- **Encrypt every folder and Git blob on the client.** Server-recoverable keys retain operator trust while adding unlock, translation, merge, and recovery obligations. Trusted Git hosting preserves ordinary files and Git behavior.
- **Use the folder name as a permanently non-reusable repository URL.** This removes the opaque ID but permanently consumes the dataset name after deletion. Supporting recreation would require another generation or alias mechanism.
- **Use names alone to recognize GitHub repositories.** Renames and name reuse can point a familiar URL at another repository. Retain GitHub's repository ID in the pairing and verify destinations before issuing credentials.
- **Require a server empty-tree commit before local opening.** It gives fresh downloads shared roots, but couples local availability to cloud setup and does not resolve later divergence. Empty repositories and explicit reconciliation keep local editing independent.
- **A per-path version service with optional local Git.** It permits independent paths to transfer during another path's conflict, but introduces version baselines, deletion tombstones, and related-file transfer bookkeeping. Reconsider it if Git hosting or audio history costs fail the feasibility gates.
- **Mirror GitHub's repository catalog.** Store the selected folder pairings and discover current repository properties from GitHub instead of maintaining another inventory.
- **Create repositories implicitly on push.** Explicit creation makes private visibility and repository identity reviewable before content transfer.
