# Git sync prototype

Run `bun packages/app/prototypes/git-sync-prototype.mjs` from the repository root. The script creates scratch Git repositories under the system temp directory, prints every replica's Markdown bytes and Git head or record revision after each step, checks the decisive outcomes, and removes the repositories when it finishes. It does not use Epicenter's production store.

The question is whether stable Markdown paths and identical bytes across desktop and browser replicas are better served by device Git branches or by conditional per-record uploads. The Git runs use real commits, a bare remote, two device clones, a fresh clone, and an integrator clone. The record run is an in-memory protocol model. Both use the same generated note bytes and the same field, body, delete, and continued-edit cases.

## Observed results

| Case | Strict whole-branch Git | Conditional records |
| --- | --- | --- |
| Offline edits to different fields of one note | Custom Markdown merge driver combines the fields; both devices later fetch identical bytes | Second upload merges against its saved base; both replicas later download identical bytes |
| Overlapping body edits | The integrator aborts; `main` stays at the accepted version and the device branch keeps its version | The rejected client's copy and server copy remain in the conflict map |
| Edit versus delete | Integration aborts without moving `main` | Conditional upload reports a delete/edit conflict |
| New note while a body conflict waits | The conflicted device's whole branch stays blocked; another device can integrate | The conflicted device uploads the new note independently |
| Stale concurrent push to one device branch | The bare remote rejects the non-fast-forward push | Revision mismatch triggers a merge or conflict |
| Fresh device | Cloning `main` recovers accepted files; the clone can also read a blocked device's uploaded branch and later edit | Reading the server's current path/revision map recovers accepted files; conflicted local bytes have no durable remote copy in this model |
| Two best merge bases | **Reproduced.** A device merged a previously fetched `main` while the integrator merged that device's earlier head. `git merge-base --all` returned two commits. | No Git graph |

The two-base case disproves the proposed invariant that one branch per device and a whole-branch integrator merge *by themselves* avoid [isomorphic-git's multiple-base limitation](https://isomorphic-git.org/docs/en/merge). A sequential second integration cycle had one base, but that run did not cover the concurrent merge race.

The script also exercises a **different Git protocol**: only devices merge, and the remote moves `main` by fast-forward. A stale attempt to advance `main` is rejected; the device fetches and merges the new `main`, pushes its branch, then advances `main`. The observed merge had one base. With overlapping bodies, the device branch kept later work while `main` stayed at the accepted version. This variant changes the requested integrator's role: the merge driver runs on a device, and the server enforces ref ancestry. It needs a server policy that prevents any non-fast-forward `main` update and prevents two writers from claiming one device branch. A one-base guarantee additionally requires device-authored commits to have device-unique identity in their hashed metadata, so two devices cannot independently create the same private commit before either is published. That corner case is reasoned about, not exercised here.

## What the prototype does not establish

- The custom merge driver only parses simple scalar frontmatter. It treats the body as one field, preserves its bytes when unchanged, and retains unknown simple fields. A production driver would need Honeycrisp's real format, multiline values, arbitrary Markdown, and explicit conflict resolution. `.gitattributes` names the driver, but an ordinary clone must install the driver command to get the same merge behavior.
- The record model holds bases and conflicts in memory. It has no persistent change feed, tombstone collection, upload acknowledgment recovery, or multi-record transaction. Its value is showing the difference in conflict scope.
- The script does not exercise an open Honeycrisp editor, a desktop agent writing during save, interruption during a browser commit, or mobile browser storage. A conflict branch has both versions in Git history, but the script stops before a person resolves the conflict.
- The existing Honeycrisp editor binds to Yjs content. Its [Markdown serializer](../../../apps/honeycrisp/src/lib/editor/markdown.ts) deliberately drops underline, and opening then saving arbitrary Markdown may normalize bytes. The repository test for this could not run in this checkout because `@y/y` was unavailable. Canonical Markdown requires an editor save boundary that preserves untouched bytes and retains a dirty draft when an external edit arrives.

## Browser feasibility

[isomorphic-git accepts a Node-like filesystem](https://isomorphic-git.org/docs/en/fs), including a promise API. LightningFS supplies one over IndexedDB. An OPFS implementation would have to expose the file and directory operations listed by that interface, including stat, read, write, and removal behavior. OPFS is private to the browser origin, so the desktop's ordinary files would be a separate replica. [MDN describes OPFS access handles and flushing](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

The browser needs an HTTPS Git remote or a trusted CORS proxy that supports Git smart HTTP, its request methods and headers, and authentication. [isomorphic-git supplies `onAuth`](https://isomorphic-git.org/docs/en/onAuth) and a `corsProxy` option; a stock remote's CORS policy may still block direct browser requests. Credentials must go only to a trusted origin or proxy. A [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) can elect one tab or worker per browser replica to mutate its repository; that does not coordinate the desktop folder. The application also needs to recover after interruption by checking its branch/ref, working tree, and outstanding remote publication at startup. Git's object IDs and ref history alone do not prove that a particular browser filesystem adapter flushed every write durably before advancing a ref.

This checkout has Playwright browser harnesses but no installed `isomorphic-git` or browser Git filesystem adapter. An isolated Bun install failed with `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`. No browser Git clone/open/commit/storage benchmark ran. Desktop Git timings here say nothing about mobile Safari performance or durability.

## Current recommendation

Keep Git as the leading **next experiment**, because the user values ordinary Git files, history, and whole-change-set publication, and has not required unrelated edits to bypass a conflicted device. Do not adopt the original integrator-merge protocol as the implementation: its multiple-base invariant fails. The fast-forward-only variant is a credible smaller protocol, but browser cost, editor byte fidelity, conflict resolution, and the exact smart-HTTP remote policy still need direct tests before replacing the Yjs store.

The smallest next implementation step is a browser-only scratch probe using isomorphic-git over a persistent IndexedDB or OPFS adapter, with a realistic corpus of small Markdown records, a reload after commit, and measurements for clone/open, commit, and storage growth. That probe should use the fast-forward-only ref rules and leave production data untouched.
