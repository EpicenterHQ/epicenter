# GitHub pairing prototype

Throwaway demo answering: can one connection support independent folder histories, and what happens when devices or repository identity disagree?

Run from the repository root:

```sh
bun apps/api/evidence/github-pairing-prototype/main.ts
```

Press Enter to advance or `q` to quit. Run all scenarios without prompts:

```sh
bun apps/api/evidence/github-pairing-prototype/main.ts --all
```

The demo runs real native Git in temporary directories. Connection ownership, installation access, private visibility, and GitHub repository IDs are simulated in memory. It makes no network requests and uses no real credentials. It ignores inherited Git configuration and removes its scratch repositories on normal exit.

Each step displays account connection, folder pairings, repository identity, checkout status, and recent history. Rename and replacement change actual scratch repository paths; authorization decisions come from the simulated model. These decisions do not establish production GitHub security.

## Findings from 2026-10-05

All eight scenarios completed on Bun and native Git:

- Notes and Todos upload independent root histories through one simulated connection.
- A second Notes checkout downloads, edits, uploads, and fast-forwards the first to matching content and history.
- Concurrent Notes edits prevent non-forced push and fast-forward; Todos still uploads.
- An independently started Notes checkout has no common ancestor. Ordinary merge refuses even though its authored filename does not overlap the remote's filename.
- Pushing successfully does not upload an uncommitted saved file.
- Renaming preserves simulated repository identity but leaves a stale origin requiring explicit review.
- Recreating the original path with a different simulated ID is refused by the pairing model. Raw Git can still push an old checkout into that empty replacement at its unchanged origin.
- Simulated authorization refuses another account, removed repository access, and disconnect. It does not delete local files.

The [current repository API](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user) lists GitHub App user and installation tokens for personal repository creation, with either Administration write or Repository creation write permission. Creation defaults to public unless private visibility is requested. Contents write alone is not a creation permission.

The live proof must still establish creation under the intended personal owner, access to a newly created repository when the installation selects specific repositories, scoped token delivery, authorization races, and browser transport. The demo does not exercise `@epicenter/folder`, OPFS, Postgres, OAuth callbacks, or production credentials.

The pairing spec this prototype served was deleted when [ADR-0521](../../../../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) replaced pairings with a folder's own remote; read it with `git log --all -- specs/20261005T134823-github-folder-pairing.md`. This prototype goes with the GitHub connector.
