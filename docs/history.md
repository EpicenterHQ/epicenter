<!-- doc-path-check: ignore-file -->

# History

This file logs what Epicenter tried, what it kept, and what it turned down,
oldest first. It is background, never instructions: the current rules live in
the `## Decisions` section of each area's README. Read it before proposing
something that may have been tried before, such as a data store, sync, sign-in,
a hosted service, or a new dependency.

```sh
grep '· yjs ·' docs/history.md      # everything about one idea
grep '· refused ·' docs/history.md  # everything turned down
```

## How an entry reads

```
## YYYY-MM-DD · slug · verdict · What changed, in a few words

What we did before, what changed, why, and what we gave up, in one paragraph.

Reopen if: the condition that would make the losing option worth another look.

See: a1b2c3d4e5, ADR-0534.
```

- Date: the day the decision landed on `main`, taken from the author date
  of the commit that made it. An entry that only a record holds uses the
  record's date.
- Slug: one short word for the idea, such as `yjs`, `folder-sync`, `oauth`,
  or `dictation`, so one grep finds its whole story. Reuse a slug before
  making a new one.
- Verdict: `adopted` (we built it), `dropped` (we built it and took it
  out), `refused` (we decided against it before or instead of building it), or
  `proposed` (accepted on paper and not yet built).
- Reopen if: required for `dropped` and `refused`.
- See: one to three pointers an agent can follow. A ten-character commit
  SHA is on `main`. `ADR-NNNN` is one of the decision records `docs/adr/`
  held until 2026-11-19; every one is in the annotated `adr-archive` Git
  tag. A record deleted before that is cited with the commit that last held
  it (`ADR-0354 as of 1b720a83ff^`). Paths name files as they were.

To read an archived record:

```sh
git show "adr-archive:$(git ls-tree --name-only adr-archive docs/adr/ | grep /NNNN-)"
```

## Adding an entry

An entry is for a decision an agent might propose again, where returning to it
would cost more than a day. Propose it and let the owner decide. Add it at the
bottom, since entries are in date order and Git merges two additions at the
end without a conflict. Correct an entry that turns out wrong; do not delete
one because its decision was later reversed: the reversal is a new entry.

A `<!-- review: ... -->` comment marks a reason or reopening condition that
the sources did not state and that the owner has not yet confirmed.

## Entries

## 2025-06-24 · browser-extension · dropped · Whispering's browser extension is removed

Whispering had a Chrome extension (version 6.5) that brought transcription into ChatGPT and other web pages. We deleted it and the code it shared with the other apps, with the note that it would be revisited when the extension was rebuilt. The commit gives no other reason. We gave up dictation through an extension in the browser; the desktop app stayed.

Reopen if: a rebuilt extension has a named use that the desktop app's dictation into the focused field does not cover.
<!-- review: the only reason is the commit's "will be revisited in the future when I rebuild the extension"; the reopen condition is inferred -->

See: 1e9d2c68a7.

## 2025-08-04 · epicenter · adopted · Whispering's repository becomes Epicenter

Until then the repository was Whispering, one free dictation app. We renamed the project Epicenter, described it as a set of local-first, open-source apps, and moved Whispering into `apps/whispering` as one app among several. A landing page, a command-line tool, and the first hosted API project arrived in the same two weeks. We gave up the simplicity of a repository that ships one app.

See: cd6684f297.

## 2025-10-01 · yjs · adopted · App data lives in a Yjs document

The shared data library kept each app's data in SQLite and treated the database as the truth. We made a Yjs document the truth instead, a format built so several devices can edit and merge, and rebuilt SQLite tables and Markdown files from it as copies for reading. The reason was a move to a collaborative workspace that syncs between devices. We gave up writing to SQL directly and took on a sync engine that shaped the next year of work.

See: 2330a28cbe, a30c04429a.

## 2025-11-21 · assistant · dropped · The Epicenter Assistant is removed for a rebuild

The Epicenter Assistant (`apps/sh`) was a web interface for OpenCode coding agents running on the person's machine or reached through an ngrok tunnel, built over about 320 commits since July 2025. We deleted it to rebuild it from scratch on a separate branch, and ten days later deleted its backend, `apps/api` and `packages/db`, as orphans. No rebuild under that name reached main. We gave up a hosted chat front end for agents running on the person's own computer.

Reopen if: someone wants to drive local coding agents from another device, and the rebuild branch or a new design names who uses it.
<!-- review: the commit says only "prepare for a clean rebuild"; why the rebuild was needed is not recorded, and the reopen condition is inferred -->

See: 32779c074d, 0b6122e480.

## 2025-11-25 · license · adopted · The license changes from MIT to AGPL-3.0

Whispering and everything around it had been MIT, which lets anyone copy the code into a closed product. We relicensed the repository to AGPL-3.0, which lets anyone run, change, and host it but makes them publish their changes if they distribute or host a modified version. The licensing strategy written later names the worry: a competitor copying the code and shipping it as their own. Versions already published under MIT stay MIT.

See: 61c28d4ab6, fd41fc2dd2, `docs/licensing/licensing-strategy.md`.

## 2026-03-11 · hosted-api · adopted · Epicenter runs a hosted service at api.epicenter.so

Apps had run on the device alone. We put a server at `api.epicenter.so` that signed people in and synced their workspaces between devices, and a week later it sold AI use through paid credits. This made Epicenter a company service as well as software a person runs. Every app that synced now depended on a server we had to keep running.

See: d8f9aec0de, 347fdb86e4, 3e7e7eaf98.

## 2026-03-12 · desktop-host · dropped · The first Epicenter desktop app is deleted

`apps/epicenter` was a Tauri app, started in January 2026, for managing workspaces. It had hardcoded workspace templates and saved through Tauri's file system plugin, a model every recent spec had moved away from. We deleted it in favor of a planned sidecar design: workspaces loaded at run time from `~/.epicenter/workspaces/`, saving through Bun, and a thin Tauri shell. Nothing depended on it, and a desktop host came back in July in a different form.

Reopen if: never as this code; a new desktop shell starts from the current design, and this source is only reference in Git history.

See: c3829ed643.

## 2026-06-13 · global-shortcut · adopted · A raw keyboard listener lets Whispering bind Fn and modifier-only keys

Whispering's global shortcuts went through `tauri-plugin-global-shortcut`, which binds only key chords. We added a raw system-wide keyboard listener built on an `rdev` fork, so a person could bind the Fn key, a modifier held alone, or a press-and-release push-to-talk. On macOS the listener needed the Accessibility grant, so on 2026-06-16 Rust took over the grant check and the listener's restarts (ADR-0011), and on 2026-06-18 macOS swapped `rdev` for Whispering's own `CGEventTap` because the fork's listener returned at once on a background thread and reported a working tap as dead. We took on a raw keyboard listener, a permission prompt, and an unmaintained fork.

Reopen if: the `rdev` fork is maintained again and fixes its macOS run-loop bug, so owning a tap no longer pays for itself.

See: 5db6e2601c, a073455b7b, ADR-0020.

## 2026-06-15 · encryption · refused · The sync server can read your data, and private means running it yourself

We had drafted end-to-end encryption, where the server stores data it cannot read. We withdrew it and removed the encryption layer, because collaboration, search, and recovery all need a server that reads the data, and few people had asked for a blind one. Nine days later we settled the promise that follows: the hosted app has no privacy settings, and a person who wants privacy runs the server on their own machine. We gave up the claim "we cannot read your data" for the hosted service.

Reopen if: people ask for a hosted service that cannot read their data, and collaboration, search, and recovery can work without the server reading it.

See: ADR-0004, ADR-0003, ADR-0068, ADR-0069.

## 2026-06-16 · media-pause · adopted · Whispering pauses any system media while recording, and only if asked

Whispering 7 paused music while recording by AppleScripting two named apps, Music and Spotify, on macOS only, so a browser tab or a video kept playing into the microphone. We replaced it with one pause and resume command over each desktop's media-session layer (MediaRemote on macOS, GSMTC on Windows, MPRIS on Linux), which never resumes a session it did not pause. A change turned it on by default, and on 2026-06-20 we turned it back off: macOS resumes whatever the system last marked as playing, so the resume could start media the person never had on. The cost is that most people who would benefit have to find the switch.

Reopen if: macOS offers a reliable way to read which app is playing without an entitlement or a private-framework shim, so resume can target the exact session it paused.

See: b77d33cdb6, 595c6d1afb, ADR-0045.

## 2026-06-18 · dictation · adopted · Transcripts go to the clipboard by default, and a paste that cannot land leaves them there

Whispering pasted a finished transcript at the cursor by faking ⌘V, which on macOS needs the Accessibility grant. We made the clipboard the default output, so a fresh install works with no permission prompt, and kept paste at the cursor as a switch. Two days later we fixed a silent loss: with a missing or stale grant the fake keystroke did nothing but reported success, and restoring the old clipboard wiped the transcript. Whispering now decides from the live grant before pasting, and a paste that cannot land always leaves the text on the clipboard, even for someone who turned the clipboard off.

Reopen if: macOS reports a dropped synthetic keystroke, so the result of a paste can be observed instead of predicted from the grant.

See: de8012a288, 298bd545a8, ADR-0040.

## 2026-06-23 · blobs · adopted · Large files go to one S3 bucket, keyed by their hash

Files too large for Git or a Yjs document had no home. We added a blob store on the shared server: the client uploads straight to an S3-compatible bucket through a presigned URL, under a key that is the file's SHA-256 hash, and the bucket is the only index, with no blob table, queue, or confirm step. Presigned URLs kept large bodies off the Worker and ran the same code on R2, MinIO, or S3; a hash key let the bucket reject bytes that did not match their address. We gave up multipart uploads, since R2 checks a whole-object hash only on a single upload.

Reopen if: a hosted service again needs to hold bytes too large for Git. This design is the starting point; the later entries record what changed in it.
<!-- review: the reopen line is inferred; ADR-0089 gives no revisit condition. The commit body and ADR-0089's context hold the reasons. -->

See: 745866ac17, ADR-0089, ADR-0091.

## 2026-06-26 · self-host · adopted · Self-hosting is a one-owner server behind one shared token

Self-host had been planned as the hosted server minus billing, with a mode switch between solo and shared and a token the box minted on first boot. We split it into its own app instead: one data partition, one static token the operator supplies, and no OAuth, Better Auth, or Postgres, while OAuth stayed with the hosted service. The record found that solo and shared differ only in how many people hold the token, and a mode switch over stored data risks silently re-partitioning it. We gave up per-person accounts, revocation, and attribution on a self-hosted server.

Reopen if: a self-hosted server must run with no database, or on a Cloudflare Worker without Postgres.

See: ADR-0075, ADR-0071, 0d68b90569.

## 2026-06-27 · oauth · adopted · Whispering signs in with an OAuth bearer on web and desktop, not a cookie

Whispering's web build could have signed in with a same-origin cookie. We chose one OAuth bearer for every Whispering surface, for three reasons: the cookie client could not open the sync WebSocket, an httpOnly cookie does not protect secrets the page already decrypted in JavaScript, and the desktop app needs OAuth anyway. We kept the web grant in `localStorage`, because `sessionStorage` signed people out on every tab close and protected little more against script on the page.

Reopen if: Whispering's web build stops syncing and stops decrypting secrets in the page, so a cookie would cover everything it does.

See: ADR-0331, 1754b18cfb.

## 2026-06-27 · transformations · dropped · Transformations are replaced by a dictionary, Polish, and recipes

A Whispering 7 transformation was one object holding find-and-replace rules, an optional AI prompt, and more rules, with one marked to run on every transcript. That fused fixing a transcript with reshaping it, so every output option repeated the same correction rules. We deleted transformations and shipped three things instead: a dictionary of words to spell right, an always-on Polish pass that keeps the speaker's wording, and a library of on-demand recipes such as Email or Notes. The bespoke Anthropic and Google completion clients went too; every provider now completes over the OpenAI-compatible request.

Reopen if: people need a chain of deterministic find-and-replace steps that an AI pass cannot do reliably.

See: bac7a18fe7, ADR-0099.

## 2026-06-30 · mail · refused · A hosted webmail app is refused, and Local Mail is the only Gmail client

A spec proposed `apps/email`, a hosted webmail page where the browser never talks to Gmail: a Cloudflare Worker held the tokens, proxied every call, and kept nothing local. Its only real advantage over Local Mail, the desktop Gmail client, was reach without installing anything, including on phones, and nobody had made that a requirement. We refused it and kept Local Mail as the only Gmail client Epicenter builds. The unused Google OAuth client made for it was to be revoked.

Reopen if: reaching Gmail from a phone or without an install becomes a committed requirement; the record says to design it fresh then, not to revive this spec.

See: ADR-0083.

## 2026-07-01 · encryption · refused · The blob store encrypts attachments

Blobs would carry personal audio, images, and PDFs, which raised whether the blob layer should encrypt them. We kept it plaintext: the sync server already read workspace data and the secret vault used a key the server could derive, so encrypted media would have been the one class of data the operator could not read. Encryption at that layer would also have charged every consumer for streaming crypto, broken ranged reads and previews, and needed a key-recovery story only some consumers wanted. A consumer that needs confidentiality encrypts before upload and owns its keys.

Reopen if: the rest of the system stops reading plaintext too, so that encrypted media is part of a consistent privacy promise rather than an exception to it.

See: ADR-0090, ADR-0004.

## 2026-07-01 · sign-in · adopted · Apps work signed out, and signing in only adds sync

We decided no workspace app gates behind sign-in. A signed-out app opened a local document in the browser, a signed-in one added account storage and sync, and the first signed-in start that found local rows offered to add, delete, or keep them. The account popover was the only place sign-in appeared, and sign-out deleted nothing. The account dashboard was exempt, since sign-in is its whole purpose.

Reopen if: signed-out work can again be kept durably on the device without a later migration step.

See: ADR-0088, 5d7767885f.

## 2026-07-01 · notes · dropped · Fuji, the power-notes app, is deleted

Fuji was built as a daily-use notes app with a richer entries table, and it was the repository's main example of how a workspace mount worked. We deleted it because it was no longer used, and moved its example role to Honeycrisp, an Apple Notes-style app. The record that made Honeycrisp the maintained notes product refused restoring Fuji or its daemon mount. We gave up Fuji's entries model and its per-row Markdown output.

Reopen if: someone uses a notes app daily that needs Fuji's entries table, and Honeycrisp's successor cannot hold it.
<!-- review: the reason is one line ("it's no longer used"); the reopen condition is inferred -->

See: 0b6d6816e6, ADR-0087.

## 2026-07-02 · vocab · refused · Vocab saves verbatim entries and refuses glosses and spaced repetition

Vocab, the language tutor renamed from Zhongwen in June, saved words that a person tapped in a chat message, which could not capture phrases. We rewrote it so a saved entry is any selected text, with a note only the person writes and a stage for how well they know it. The record refuses a stored dictionary or gloss, an AI-written note, spaced-repetition scheduling, review counters and streaks, tags or decks, and any record of where an entry came from. Selection made dictionary prefill unreliable, the chat already answers what a phrase means, and the refusals removed a scheduler and a dictionary to maintain.

Reopen if: the person routinely pastes definitions into the note (then a prefill into the note, never a second meaning field), or "where did I save this from" becomes a real question (then one conversation-id column).

See: ADR-0102.

## 2026-07-03 · billing · refused · Transcription overspend is not guarded by measuring audio first

Hosted transcription checked only that a wallet held at least one credit, because a recording's cost is its length and the provider reports that after the call. We refused to probe or decode audio before the call and refused an exact credit hold for it. No comparable provider does such a check, a single call is already capped by the provider, and it would commit Epicenter to a media subsystem for headerless, variable-rate, and streamed audio. We chose cheap guards added only when abuse appears: an upload size cap, a limit on concurrent transcriptions per person, then free-tier changes.

Reopen if: the size cap, concurrency limit, and free-tier changes are all in place and overspend still happens, or a provider starts reporting duration before it transcribes.

See: ADR-0103, 455547774a.

## 2026-07-03 · local-transcription · dropped · Three local engines give way to transcribe.cpp and the Hugging Face cache

Whispering ran local transcription through `transcribe-rs` with three engines, whisper.cpp, Parakeet, and Moonshine, each with its own model format, download source, and a catalog kept in TypeScript; whisper.cpp could not even build on Windows. Following Handy, another open-source dictation app that had moved to transcribe.cpp, we made transcribe.cpp running GGUF models the only local runtime. Rust now owns the model catalog, names each model by its Hugging Face coordinate, and downloads into the shared Hugging Face cache, where a file another tool already fetched is reused. Existing local model choices and downloaded models broke on purpose, with no migration, and live streaming stayed out of scope.

Reopen if: a model people need runs only in another runtime, such as an ONNX-only model that transcribe.cpp cannot load.

See: 786fa00248, ADR-0757, `apps/whispering/specs/20260702T120000-local-models-huggingface-transcribe-cpp.md`.

## 2026-07-06 · scripting · refused · Super Chat loads no user TypeScript tool modules

Super Chat, the desktop host's chat that could call every app's actions, had been heading toward loose TypeScript tool modules: files dropped into a folder, imported into the host, and given a host API. We limited version one to the built-in Epicenter apps, with no folder scan, no dynamic import of user files, and no install flow; MCP could stay only as an adapter for one named external tool. The loader would have promised safe running of third-party code, trust, pinning, compatibility, and support before any third-party app existed. We gave up a scripting surface inside the chat host.

Reopen if: a person needs one program that runs a batch or conditional workflow; the record says that need is real but must not run arbitrary source inside the host.

See: ADR-0111, ADR-0097.

## 2026-07-09 · global-shortcut · dropped · Global shortcuts are plugin chords only, and the Fn key and `rdev` go

The raw keyboard listener existed to bind Fn, modifier-only holds, and push-to-talk. Off macOS those gestures barely worked: `rdev` had no Fn key on Windows or Linux and no Wayland support, and none of the gestures had been proven on real hardware even on macOS. Since the plugin reports both key press and key release, push-to-talk works as a chord held down. We deleted `rdev` and the gesture matcher and refused Fn and modifier-only shortcuts everywhere; the macOS tap stayed only to tell whether paste at the cursor would land.

Reopen if: holding Fn the way macOS dictation does becomes a core promise, proven live on a Mac, with a macOS-only record, as ADR-0117 itself names.

See: f4a919a4cd, ADR-0117.

## 2026-07-10 · desktop-host · adopted · Epicenter ships as one desktop app that hosts every app

Whispering was its own desktop program, and a chat app that could call the other apps' actions was becoming a second one. We chose one signed desktop app, Epicenter, that serves every built-in app from one local address and owns recording, shortcuts, and windows for all of them. Shipping separate programs would have doubled the installers, permissions, and updates. Use from a phone became remote access to that one desktop session, and we stopped building a way for each app to be reached across devices.

See: ADR-0080, ADR-0118.

## 2026-07-18 · blobs · dropped · A file's hash is its address

Blobs were addressed by their SHA-256 hash, so the same bytes got the same URL. We replaced the hash with a random `blob_` ID that the caller mints. Content addressing made every caller buffer and hash the whole input before it had an identity, exposed integrity machinery as the product's identifier, and tied a recording saved on the device to the key of its hosted copy. We gave up automatic deduplication and self-describing URLs.

Reopen if: deduplication becomes worth a second index from ID to hash, or callers already hold the whole input and its hash anyway.

See: e354adb79b, ADR-0148.

## 2026-07-20 · transactions · refused · An edit that spans several rows commits as one

Sync grouped pending changes into batches for transport, and treating a batch as a commit would have promised atomic changes across rows. We refused that: each row or value converges on its own, and no other device is promised to see several rows change at once. Values that must change together go in one row or one row document; a real invariant across rows belongs in a server built for that app. Apps gave up atomic parent-and-child creation, cascades, and cleanup across rows.

Reopen if: several apps need the same cross-row invariant and each building its own server for it costs more than one shared mechanism.
<!-- review: reopen line inferred from ADR-0164's "application-specific semantic authority" clause; the record names no trigger. ADR-0212 kept this refusal when it changed the rest. -->

See: ADR-0164, c3e5f59718.

## 2026-07-26 · local-transcription · adopted · The host owns one active local model, and apps cannot name one

When the Epicenter desktop app hosted every app, one model cache served them all, so an app naming a model per request would silently switch the machine's model for every other app. We gave the host one active local model, administered in Epicenter Home, and took the model argument out of the transcription commands. This reversed the per-call model name that ADR-0012 had set on 2026-06-16. Whispering lost its own local model picker.

Reopen if: two apps share one model cache again and one app's choice of model could change another's results.

See: ef4c44c1ef, ADR-0180.

## 2026-07-29 · notes · dropped · Opensidian is retired

Opensidian was a notes app with a file tree, a terminal, a search panel, and the chat prototype that first called tools on other devices. It had its own domain and sign-in client. The data layer had just removed the file system, shell, and SQLite index that those panels were built on, so keeping it meant restoring capabilities that were refused on purpose, and an earlier record had already called its cross-device chat superseded by the super app. We deleted the app, and tokens issued to its sign-in client stopped working.

Reopen if: a real, named consumer needs per-app tools reachable over the network, which is the bar ADR-0086 set.

See: 30c736fd60, ADR-0086.

## 2026-07-30 · yjs · dropped · The root Yjs workspace goes, and rows move to SQLite synced in server order

Since October 2025 every app's data had lived in one Yjs document per workspace. We moved each row into a SQLite replica on every device, synced as patches that the server applies in the order it accepts them, and kept Yjs only for a lazily loaded document per row for text that must merge. The reason was memory: a device had to load the whole CRDT before it could query, so memory grew with the whole collection. The cutover deleted the workspace package, the encryption package only it used, and the Room Durable Objects, about 45,000 lines; deploying it erased what those objects stored.

Reopen if: Yjs can load part of a document, so a query no longer needs the whole collection in memory.

See: b93279633b, ADR-0166, ADR-0119.

## 2026-07-30 · cli · dropped · The `@epicenter/cli` watcher is deleted

`@epicenter/cli`, published as version 0.1.0, ran one folder with no window: `up` opened it, claimed a lease, joined sync, and kept Markdown output running, while `down`, `status`, and `logs` managed that process through pid files and signals. Every verb read the workspace package whose mount and daemon model had just been replaced, so we deleted the package. Three commands went with it: `auth` for a headless machine session, `blobs` for file uploads, and `matter` for a SQLite mirror of a Markdown folder. An earlier record had already refused turning the watcher into a local server that runs actions.

Reopen if: a folder needs a process that keeps working with no window open, and none of the current programs can do it.
<!-- review: the reason is from the commit; the reopen condition is inferred -->

See: 946064c128, ADR-0112, ADR-0009.

## 2026-08-05 · desktop-host · dropped · Home stops being a shell above the apps

Two weeks earlier, Epicenter Home had been made the shell above every workspace, owning navigation, the assistant, and commands, and it launched each app into its own window while staying open behind them. Windows piled up, and Home became a window whose only job was having launched something. One window with a switcher failed on Tauri: a window is the unit that native permissions are granted to, so one window would hold every app's permissions at once. We decided Epicenter is an app beside the others that shows the data raw, and the operating system is the launcher and switcher; in October Home became the Settings window.

Reopen if: Tauri can grant permissions per webview inside one window without its unstable feature, and window management is a real complaint that the OS's own switcher does not answer.

See: ADR-0209, ADR-0152, ADR-0537.

## 2026-08-07 · yjs · adopted · Rows go back into Yjs, and the hand-built sync protocol goes

One week after the SQLite cutover, rows synced through a protocol we wrote ourselves: numbered intents, sealed batches with receipts, watermarks, and three separate recovery paths. We made each row a Yjs type inside the app's document again. Measured on a real 986-note vault, Yjs 14 beat a hand-built cell store on every axis we checked (3.02 MB against 5.11 MB stored, 43 bytes against 172 per changed field), and one Yjs state vector replaced all three recovery paths. We gave up resolving two writes to the same field by recency: in Yjs the device with the higher client ID wins.

Reopen if: an app needs concurrent writes to one field to resolve by time, or Yjs's memory per row exceeds what a device can hold.

See: 544301c52f, ADR-0212, ADR-0163.

## 2026-08-08 · desktop-host · adopted · Desktop is the only place apps run, and the first data stack is deleted

The repository supported five ways to run an app: a hosted website, a standalone desktop bundle, the desktop host, a server process, and a Chrome extension. We kept one, a page inside the Epicenter desktop app, over a rewritten store that the app itself holds. We refused hosted web apps, deleted the tab manager extension, and put off apps from other developers. We deleted the old data stack instead of keeping it working, and accepted that data saved in it was lost, with no importer.

See: ADR-0227, ADR-0224.

## 2026-08-10 · chat · dropped · Remote Super Chat from a phone is deleted

A month earlier we had built a hosted relay so a phone could attach to the Super Chat session running on the desktop, with pairing grants, a host directory, a Cloudflare Durable Object, and a client adapter. We deleted all of it, because the complete remote experience did not exist and dormant routes made an unfinished feature look supported. It also needed its own Durable Object class while hosted storage was being reset to a single one. We gave up chatting with the desktop's apps from a phone.

Reopen if: a new record names the complete user-facing remote experience it serves; restore the relay from the parent of the deleting commit only then.
<!-- review: ADR-0236 names the deleting commit as 19b9ee6a73, which is not on main; the commit on main is 4cc2092196 -->

See: 4cc2092196, ADR-0236, ADR-0115.

## 2026-08-28 · data-store · dropped · The browser stores its data in SQLite over OPFS

ADR-0275 moved the browser's durable copy from IndexedDB to SQLite running in a worker over the origin-private file system (OPFS), and it was built. We reverted it the next day because none of its three arguments held: the cross-tab guard against two writers was already an exclusive Web Lock, OPFS has the same quota and eviction as IndexedDB, and OPFS is no more visible to the person. The worker existed only because a SQLite file system needs synchronous file handles, and once a document was stored as one whole value, the async file API on the main thread was enough. We gave up SQL queries over the browser's stored copy.

Reopen if: the browser needs to query its stored data with SQL rather than read one whole document.

See: 7cf2e01b6c, ADR-0275, ADR-0280.

## 2026-08-29 · license · dropped · One license, and no toolkit for other developers

Since March 2026 a few packages had been MIT so other developers could build them into their own products, while the apps stayed AGPL. No such developer arrived, most MIT packages had only AGPL users, and the rule that kept the two tiers apart was moving code to the wrong places. We made everything AGPL-3.0-or-later and marked every package private. Bringing MIT back needs a named developer who wants to build on a package, not a hope of one.

Reopen if: a named developer wants to build a product on one of the packages.

See: ADR-0288.

## 2026-08-29 · yjs · dropped · One Yjs document per row

On 2026-08-20 each row's rich content became its own Yjs document at an address derived from the row, so lists could load titles without loading every body. Nine days later we made a database one Yjs document again, with rich fields nested in the row. In Yjs the document is also the sync stream, the storage object, and the server's unit, so the split had bought an envelope to multiplex documents, one Durable Object per row, identity stamps, and a protocol to delete across two documents; measured, it saved only about half the memory on the client, and on the server it cost 30,001 objects per database at a per-object overhead 8.2 times the content. The same commit kept the server blind to the bytes, undoing a one-day switch to a server that read Yjs.

Reopen if: Yjs can load part of a document, or real databases outgrow the measured device budget (about 127,000 pages in a browser tab on an iPhone 15 Pro) so bodies must stay off the startup path.

See: db847017ce, ADR-0295, ADR-0248.

## 2026-09-06 · sign-in · refused · A signed-out trial that keeps nothing

A proposal let a signed-out app run on a store in memory that vanished with the tab, so people could try an app before making an account. We rejected it the same week: a person who records a dictation signed out and closes the tab loses it, and nothing tells them at the moment it matters. Apps instead show a sign-in screen and open no store while signed out, which made official what the July promise of signed-out use had already lost in code. The cost, named in the record, is that bring-your-own-key transcription needs an account before the first recording.

Reopen if: a signed-out app can keep work on the device durably, so trying it loses nothing.

See: ADR-0342, ADR-0088, 36330fdca8.

## 2026-09-07 · oauth · dropped · Session bearers replace OAuth for every client

The hosted API had run an OAuth provider since March, and on 2026-08-28 a duplicate refresh deleted a person's whole refresh family and signed them out of every device. We replaced OAuth with Better Auth session bearers handed to each client through a short PKCE-bound code. Every client was first-party with the same access, no route checked a scope, every client skipped consent, and people paid for two credential lifecycles. We gave up limited, delegated access; the record said a client that needed it would reopen the choice.

Reopen if: an untrusted or third-party client needs limited, delegated access to a person's data.

See: ADR-0354 as of 1b720a83ff^, 0c329cbb54, 23bade0df4, 47a48940fd.
<!-- review: ADR-0354 was deleted before the adr-archive tag; the reasons here come from ADR-0549's history table -->

## 2026-09-08 · accounts · dropped · Self-service account deletion is switched off

In July we built a route, a coordinator, and dashboard UI that deleted a hosted account. It removed blobs, billing, and the sign-in record, then reported success while leaving store authorities, ledgers, and verification records behind, and ongoing writes could recreate deleted data. We made the route refuse before doing anything and disabled the button, with no automated deletion for a version that had no real users. People could not delete their own hosted account from then on.

Reopen if: self-service deletion becomes a product requirement, or deleting accounts by hand becomes recurring work for the operator.

See: ADR-0360, 48784510b3, a8f82f266d.

## 2026-09-18 · openai-compatible · dropped · Deepgram, ElevenLabs, and Mistral adapters give way to OpenAI-compatible endpoints

Whispering 7 talked to each transcription vendor in its own protocol, with its own settings and dispatch code for Deepgram, ElevenLabs, and Mistral beside the OpenAI-shaped ones. We deleted those adapters: every transcription destination is now a base URL and an optional key spoken to over the OpenAI request shape, and a vendor that offers that shape is added as a custom endpoint. Old provider keys and settings stay stored but are never read or imported. People who used those vendors directly lost them unless the vendor offers an OpenAI-compatible endpoint.

Reopen if: a vendor people rely on offers no OpenAI-compatible transcription endpoint and a proxy cannot fill the gap.

See: 6225905ee9, ADR-0398.

## 2026-09-24 · billing · adopted · Whispering stays free, and a subscription pays only for hosted services

We decided apps stay free and one Epicenter Cloud subscription pays for services Epicenter runs, with Whispering as the first place to buy it. Its first benefit was hosted transcription without setting up a local model, a provider key, or a server. On-device models, a person's own provider key, and a self-hosted endpoint stayed free, and there was never a separate Whispering license. The record left price, included models, and allowances open.

Reopen if: Epicenter needs revenue from an app itself rather than from services it runs.

See: ADR-0442, 7e2105f3d0.
<!-- review: the record stayed Proposed; Whispering's hosted transcription behind sign-in (6544a18fb8) is the evidence it was acted on. The reopen condition is inferred; the record gives none -->

## 2026-09-24 · transformations · dropped · Recipes leave Whispering, and only transcript cleanup stays

Recipes ran saved instructions on selected or copied text, often text unrelated to any recording, so treating them as a step after Polish described the wrong caller. We removed Whispering's recipe store, picker, commands, and shortcuts, and handed selected text to Capture instead. Polish was renamed cleanup: an optional light pass on each transcript, with the original text always kept beside it. A saved-command library for any text was left to a separate capability that does not belong to a speech app.

Reopen if: a general text-command capability outside Whispering exists and Whispering needs to call it, or people miss recipes inside the dictation flow itself.

See: 4b298ea2f3, ADR-0440.

## 2026-09-30 · domains · proposed · epicenter.so is the one product address, and other domains redirect to it

Epicenter owned several domains, and registering one per app fragmented its identity and added renewals. We made `https://epicenter.so` the canonical address and planned `epicenter.software`, `epicenter.md`, and `getepicenter.com` as permanent redirects that keep the path and query, leaving each domain's email alone. A new product domain needs its own product identity, not a feature name; an app can live at a subdomain such as `music.epicenter.so`. The redirects live in Cloudflare, not in this repository, and whether every alias is set up this way has not been checked.

See: 98de355c46, ADR-0472.

## 2026-10-01 · whispering · dropped · Whispering keeps its recordings in the Yjs store

Whispering stored recordings in the Yjs store with an account, rendered Markdown copies from it, and kept audio in a separate blob store referenced by `audioBlobId`. We rebuilt it as a standalone desktop app that keeps recordings, transcripts, and settings as files in one Git folder. Under the store, editing a Markdown copy did nothing until it was pushed back, copying the Markdown alone could not recover a recording, and deleting a recording left its audio behind. Whispering gave up its account, sync through the store, and the workflow that ran only inside the Epicenter host.

Reopen if: Whispering needs several devices editing the same recording live, which files and Git cannot merge.
<!-- review: reopen line inferred. The commit message is thin; the reasons come from ADR-0450's context, written three days earlier. -->

See: 8bc2aafd03, ADR-0450.

## 2026-10-01 · dictation · dropped · Whispering stops push-to-talk, voice-activated recording, and paste at the cursor

The Whispering 7 line could record while a key was held, start and stop on its own when it heard speech, paste the transcript at the cursor, pause other media, and show a floating recording pill. When Whispering was rebuilt as a standalone desktop app over a folder of files, all of these went from the page, along with global shortcuts and automatic delivery to the clipboard. One start-and-stop global shortcut came back on 2026-10-31, and Whispering 8's README lists the rest as not supported, with copy buttons as the only way text leaves the app. The voice-activity recorder still lives, unused by the app, in `apps/whispering/packages/recorder`.

Reopen if: people want system-wide dictation back badly enough to accept the Accessibility grant again; the native code is in the `folder-sync-product` tag under `apps/epicenter/src-tauri/src/`.

<!-- review: the commit and the README only list these as removed; no record or commit message gives a reason. The README's reason for transcription being a button ("nothing is sent to a paid endpoint on its own") is the only stated motive nearby. Check with the owner. -->

See: 8bc2aafd03, ADR-0596.

## 2026-10-03 · working-copy · dropped · A folder stops being a working copy of the Yjs store

Since September a data folder could be a working copy of an app's Yjs store: `pull` wrote the store out as Markdown files with a manifest of what it wrote, and `push` compared the files against that manifest and sent the differences back. Once a folder's own files were the saved data, that second representation and its comparison had no job, and no app called it; only tests, a benchmark, and a host route did. We deleted the checkout API, the manifest and baseline code, and the host's checkout route, with no converter for old manifests. We gave up editing a Yjs-backed app's data as files and pushing it back.

Reopen if: an app keeps its truth in a store other than files and people need to edit it as files; that means taking on a second saved copy and reconciling it, which the record names as the cost.

See: 5984d2cbde, ADR-0501, ADR-0337.

## 2026-10-12 · auto-commit · dropped · Saving a file stops making a Git commit

Every save in a data folder asked for an automatic commit, and the browser, Bun, and desktop each carried a request counter, a worker that batched requests, and an option to turn it off, which 89 test setups did. Saves had just become one per edit, so a commit per save would fill history with near-identical versions. We made a commit happen only when sync runs or a person presses "Save version", and deleted the automatic machinery. We gave up a history entry for every change a person made.

Reopen if: writes become coarse, deliberate units (one per meaningful action rather than per keystroke) and a person wants each one in history; a commit per action did return in November (ADR-0842) and was dropped again with the one-repository home.

See: b3318143d6, ADR-0529, ADR-0468.

## 2026-10-14 · yjs · dropped · Plain files replace the Yjs store, and Matter, Local Mail, and Skills are deleted

Three data models ran side by side: the Yjs store synced through our servers, data folders of Markdown and JSON files with Git history, and Matter, a separate tool for Markdown tables. We kept data folders as the only model, so a person, an app, and an agent all edit the same files, and Git moves them to a server the person chooses. Local Mail, Skills, and Matter went, with the data people had synced through the store. We gave up real-time sync: a folder syncs only when someone runs a Git transfer.

Reopen if: an app needs real-time sync, such as two people typing in one note at once.

See: ADR-0534, ADR-0521, ADR-0450.

## 2026-10-14 · folder-sync · dropped · Folders stop syncing through a GitHub connector, and Epicenter hosts the Git

A browser folder synced only with GitHub, through a GitHub App connector in the hosted API that relayed every Git request with a token for one repository. GitHub, GitLab, and Bitbucket send no CORS headers, so every byte a browser exchanged with them had to pass through a relay holding a third-party credential; a person without a GitHub account had no sync, and someone using both browser and desktop set up two credentials. We deleted the connector and its stored grants and made Epicenter's server speak Git smart HTTP with a token, storing repositories on Cloudflare Artifacts. We gave up syncing a browser folder with the person's own GitHub repository.

Reopen if: a Git host serves CORS headers on its Git routes so a browser can reach it without a relay, or people ask to sync with a repository they already keep on GitHub.

See: 74198a5cdc, ADR-0521, ADR-0546.

## 2026-10-15 · oauth · adopted · One OAuth 2.1 authorization server in every deployment, self-host included

Five weeks after dropping OAuth for session bearers, we brought it back as the only credential every resource accepts: opaque access tokens bound to one audience, from one authorization server on Better Auth 1.7.9. Third-party MCP clients needed delegated, limited tokens, and a session handed to Git's credential helper could delete the account and be copied into the login keychain. A spike showed the new Better Auth version fixed both earlier failures, the device grant and the lost refresh family. Self-host became the hosted API's Bun entry on Postgres with the same server, and the separate one-token self-host app was deleted; a day later we dropped a vendored Better Auth patch and accepted that a replayed refresh signs every installation of that client out.

Reopen if: no client needs a narrow or delegated token any more, which is the argument the 2026-11-17 API key plan made.

See: ADR-0549, ADR-0565, 86b6f146a9.
<!-- review: ADR-0549 says only that self-host "runs the same authorization server"; it gives no separate reason for deleting the one-token self-host app -->

## 2026-10-16 · blobs · dropped · Attachments live in a separate blob store

Rows referred to audio and images by blob ID, and the bytes lived in a hosted S3 store and a local blob directory beside the data. Two days after the Yjs store went, we deleted the hosted blob routes and the blobs package, and an attachment became a file in the data folder next to its note. A complete copy of a folder now had to contain the bytes of every file it owns, not a pointer to them. We gave up hosted attachment URLs and storage outside Git.

Reopen if: attachments grow too large or too many for a Git folder to hold, or an app must share one file across folders without copying it.
<!-- review: the deletion commit has no body. The reasons come from ADR-0450 and ADR-0456; the reopen line is inferred. -->

See: c2cfe59b98, ADR-0450, ADR-0456.

## 2026-10-16 · mcp · dropped · Epicenter hosts no MCP server for hosted folders

The day before, we built an MCP server so Claude.ai and ChatGPT could read and commit to a person's hosted repositories. Each tool call copied the whole repository into memory and refused one over 8 MiB, so folders with recordings could not be served, and `mcp.epicenter.so` was never routed. We deleted it with its third OAuth audience and client metadata documents, because an agent on the person's machine already has the files, `git`, and the CLI, and a phone uses the browser apps. We gave up chat access to hosted folders from Claude.ai and ChatGPT.

Reopen if: people ask for Claude.ai or ChatGPT to reach hosted data, and a server can answer a tool call without copying the repository into memory.

See: ADR-0578, ADR-0550, 089cb3838f.

## 2026-10-16 · chat · dropped · Home Chat, the last part of Super Chat, is deleted

The Settings window, formerly Home, had a Chat pane: the host's chat session and the last running part of Super Chat, with catalogs of local tools and MCP servers and a relay for model calls. We deleted it in one commit that states no reason. The same day a record removed the Bun host process that the chat session ran in, so agents reach folders through Git, the `epicenter` command, and MCP instead. We gave up chatting with every app from inside the Epicenter desktop app.

Reopen if: a chat that calls every app's actions is wanted again, and there is a long-running process for its session to live in.
<!-- review: the commit message gives no reason; the context comes from ADR-0556, which lists the deletion as already done; the reopen condition is inferred -->

See: 2ecb00b5ca, ADR-0556, ADR-0111.

## 2026-10-17 · dictation · dropped · Native dictation code is parked behind an off-by-default feature, then deleted

The Epicenter desktop app still compiled and registered paste at the cursor, the Enter keystroke, media pause and resume, the macOS keyboard tap, and the recording overlay, though no page could call any of them. Every registered command would become part of the page API at the first release and stay there. We moved the whole family behind a `dictation` Cargo feature that is off by default, so the default build neither compiles nor starts it, and on 2026-11-08 it was deleted with the Epicenter desktop app. We kept the platform work, such as the owned macOS tap and the CoreAudio check, only in Git history.

Reopen if: a decision about the native API names which dictation commands a page may call and who grants them, as ADR-0596 requires.

See: a6d6ab0e51, 11ea49b95f, ADR-0596.

## 2026-10-18 · oauth · refused · Client metadata documents for third-party browser apps

A third-party app is a static site at an origin Epicenter never sees in advance, so it had no client id to sign in with. On 2026-10-17 we proposed that such an app publish a client ID metadata document on its own origin and use the document's URL as its client id. The next day we withdrew that before it was built: an app's web origin is its client id, its first sign-in creates its client row, and nothing is registered or hosted, for first-party apps as well. Because several apps and people share one repository, each consent names the one repository the app may reach.

Reopen if: an authorization server must accept clients that publish metadata documents, as MCP clients such as Claude and ChatGPT do.

See: ADR-0614, ADR-0606, 38d61ddb24.
<!-- review: ADR-0614 states the origin rule but never says why metadata documents lost; the origin rule itself was never built -->

## 2026-10-19 · hosted-api · adopted · Hosted inference stays, and an inference grant reaches no repository

Earlier that day a record removed the hosted inference and transcription gateway, its AI credit billing, and the `ai` scope, because the planned product held only repository storage. The deletion was never applied, and a second record that day reversed it. Hosted inference stayed as an account benefit with an included allowance, and its grant became separate from repository access: an app could get inference without choosing or creating a repository, and inference granted no Git access. Someone could sync with GitHub and transcribe with Epicenter, or sync with Epicenter and use a local model.

Reopen if: Epicenter's hosted product narrows to repository storage alone.

See: ADR-0634, ADR-0618, 58ff78b5ce.
<!-- review: the reopen condition is inferred from ADR-0618's stated reason; ADR-0634 gives none -->

## 2026-10-19 · sign-in · adopted · Apps open local data before anyone signs in

Since September an app showed a sign-in screen and opened nothing while signed out, and the browser opener returned nothing without a repository grant. We made every app open, save, and reopen local data before first sign-in, with a local identity independent of any account or remote. Connecting sync attaches existing local work to one chosen repository and asks before combining a non-empty folder with a non-empty remote. Whispering was the case: it must start with local data, and a person may later sync, use only hosted inference, or never sign in.

Reopen if: an app's data must live on a server from its first save.

See: ADR-0633, 58ff78b5ce, 6544a18fb8.

## 2026-10-30 · web-apps · dropped · Browsers stop running Git, and web apps work only online

Each browser app kept its own Git clone of a folder in the browser's private file system, run by isomorphic-git, and synced it with the server. Measurements showed slow clones (110 seconds for 10,000 rows before a shared cache), and WebKit returned zeroed or mixed bytes after a file was replaced and refused writes partway through a 5,000-file checkout. We deleted the browser's Git exchange because no shipped app called it, and a week later decided every web app is online: it signs in and reads the repository through the server, and offline work belongs to an installed app. We gave up editing in a browser tab with no network.

Reopen if: browser file storage becomes reliable in WebKit and people need offline editing on a device where they cannot install an app.

See: a705179adf, ADR-0623, ADR-0786.

## 2026-10-31 · desktop-host · dropped · Apps become separate programs again

The Epicenter desktop app had two jobs: it managed folders, and it hosted Todos, Capture, Honeycrisp, Whispering, and Messages in its own windows. Once an app's data was a file layout that any program may write, hosting bought only a second build and a second release channel for each app. We made each app its own program and left the Epicenter app to manage folders only. This reversed the July decision to ship everything as one desktop app.

Reopen if: apps share enough beyond a file layout that one host saves more than a second build and release channel for each.
<!-- review: inferred; the source gives no reopening condition -->

See: ADR-0700, ADR-0701, ADR-0611.

## 2026-11-04 · oauth · refused · One sign-in shared by every program on a machine

On 2026-11-03 we decided a machine has one sign-in: one keychain item that Whispering, the Epicenter app, and the CLI all read, with a lock file for refreshes. A spike the next day on macOS found that programs signed separately cannot share one keychain item without prompts, a rebuilt CLI binary is prompted again, and rotating refresh tokens hit this on every refresh. A broker holding the token for everyone could not tell which program was asking. We chose that every app signs in as its own site's origin, desktop apps through a loopback redirect, and gave up signing in once for the whole machine.

Reopen if: separately signed programs gain a way to share one keychain item without prompts, or a broker can verify which program is calling.

See: ADR-0731, ADR-0720, 68a32130df.

## 2026-11-04 · daemon · refused · No background service owns sync

The Epicenter app ran `epicenter sync --watch` for as long as it ran, and ADR-0713 made it the one program on a machine that synced folders, so every other app showed "Syncing needs Epicenter" without it. We decided sync is an operation on a folder, like save: any program with a credential runs a round when the person acts (opening the app, after a save, returning to the window), a lock in the folder keeps two rounds apart, and programs never call each other. The record refused a background service started at login because it is a process the person did not open and needs a Pause to stop. Two days later ADR-0819 had each program keep its open folders in sync while open, and the Epicenter app kept every folder open while it ran, which brought a single long-running syncer back in practice.

Reopen if: people need another device's changes to appear while no Epicenter program is open, and accept a process that starts at login.

<!-- review: the refusal in ADR-0750 was partly reversed two days later by ADR-0819 (e5ef6e7ad5); both died with the folder sync product on 2026-11-07. Check whether this is worth an entry or should fold into the 2026-11-07 entry. -->

See: ADR-0750, ADR-0713, 2bce0c9414.

## 2026-11-04 · openai-compatible · adopted · Every model is an endpoint, including the one inside the app

`@epicenter/ai` reached models through a separate constructor for hosted, local, and custom models, and Ollama or LM Studio were form presets a person typed in. We made every source of models an endpoint and merged them in one array: the person's own keys, local servers that Whispering finds by probing their usual addresses, and transcribe.cpp running inside the app with no HTTP port. A request records its endpoint and model when it starts and fails if that endpoint is deleted or moved, never falling back to another. We refused a model server shared by every app and model files kept in each app's own folder.

Reopen if: several programs on one computer need to share one loaded model, so a single model server earns its port.

See: 4d734f2e33, ADR-0757.

## 2026-11-05 · folder-sync · adopted · Folder sync becomes a product for groups, synced only through Epicenter servers

Folders had synced over plain Git to any server the person chose. We redesigned the product around spaces, groups such as a family or a couple who share folders, and decided that a folder syncs only with an Epicenter server, hosted or self-hosted, that keeps every version and decides who may see what. The design grew to web and phone apps and sharing by email. We gave up syncing a folder with GitHub or GitLab.

See: ADR-0802, ADR-0803, ADR-0835.

## 2026-11-05 · yjs · refused · A Yjs document store beside folders

Two days earlier, ADR-0705 proposed a second kind of store: one Yjs document synced through the person's account, for data like a tab manager's saved tabs that is edited offline from several browsers. We refused it and kept the folder as the only kind of store. No app co-edited live, no app edited an attachment in place, and a second store would have brought back the problems that removed the Yjs store: Markdown copies that agents could not edit without an import, and tombstones that grew on every device. None of the document store was built.

Reopen if: an app needs live co-editing; per ADR-0771, that app brings its own design.

See: ADR-0771, ADR-0705, 3598a3de17.

## 2026-11-07 · epicenter · adopted · Epicenter is where one person's software lives, and folder sync stops

The folder sync product for many people was mostly unbuilt, and its one user, the owner, rarely edited on two computers in a week and shared nothing. We narrowed Epicenter to one person's software: each app is a folder with its code and its data, and each action is a command for the person and a tool for their agents. We stopped the sync engine, the server that keeps history, sharing, and the web and phone apps, and the next day deleted the Epicenter desktop app and the apps built on folder sync. For this period a non-developer cannot use Epicenter.

See: ADR-0840, ADR-0841, ADR-0842, ADR-0843.

## 2026-11-07 · mcp · adopted · The CLI serves a folder's operations as MCP tools on the person's machine

With the hosted MCP server gone, we let agents import typed tools locally. `epicenter mcp` speaks MCP over standard input and output and renders its tools from the same table of operations as the CLI's commands and help, plus tools derived from each folder's contract. Writing an MCP server by hand would have been a fourth copy of each command that drifts from the others.

Reopen if: agents that cannot run a local process need the tools, which brings back the questions of the 2026-10-16 entry.

See: ADR-0827, ADR-0799, 0ba475a5ee.

## 2026-11-07 · ledger · dropped · The server keeps folder history in its own log instead of Git

The server stored each folder's history as a Git repository on Cloudflare Artifacts. Reviewers measured the cost: every poll walked Git objects, a file's history had no route, unrelated writes contended on `main`, and each commit rewrote a directory's whole tree, so a year of recordings stored gigabytes of trees. We moved history into a Postgres log of file versions keyed by SHA-256, the "ledger", with Git only as the way history enters and leaves, and deleted the Artifacts store. The same day Epicenter narrowed to one person's software and the folder sync product stopped, so the ledger was built and abandoned within a day.

Reopen if: Epicenter again runs a server that keeps versions of many people's folders; the measurements against Git storage in ADR-0824 would apply again.

See: 0c93360bb9, ADR-0824, ADR-0835.

## 2026-11-09 · git-sync · dropped · `epicenter sync` is deleted, and nothing pulls

After the narrowing, devices still kept copies of an app that pulled from a meeting point and merged. We deleted `epicenter sync`: an app lives on one home computer, phones and agents without the files call its actions, and Epicenter only pushes fast-forward to an optional backup remote, never pulling. A refused push leaves the commit local and tells the person to look. The record's reasons: pulling before a run or on a timer changes live files under an agent or editor and puts merge decisions into normal operation. We gave up editing the same app's files on two computers.

Reopen if: the owner regularly edits one app's records on two computers that cannot reach the home, and accepts merge decisions during normal use.

See: c5df3d2da7, ADR-0851.

## 2026-11-09 · action-commit · dropped · An action stops being a Git commit, and whoever knows the intent commits

Two days earlier each action call had become its own commit, and the runner was built to commit exactly the paths a call wrote, with a lock per app so calls took turns. The owner's most used personal repository showed who actually knows a change's intent: 479 commits since October, each written by the agent that made the change and named for what it meant, while an action knows only its own effect. We made an action write files and nothing else, with no commit, no undo, and no lock, and left committing to the person or their agent. We gave up an automatic history entry for every call.

Reopen if: actions run where no person or agent is around to commit, and their changes need to be recorded one by one.

See: c144c898ff, 55aec2de3c, ADR-0850.

## 2026-11-10 · git-lfs · dropped · New apps stop routing binaries through Git LFS

Git LFS had been the plan for audio and images since the folder sync product (ADR-0640, ADR-0734), and on 2026-11-09 `epicenter new` wrote a `.gitattributes` that sent audio, images, and PDFs through LFS and refused a write to such a path without the LFS filter installed. A day later we removed those rules: they applied to apps that hold only text and made every commit fail on a computer without LFS. An app that holds binaries now adds its own rules. Today Whispering only reports whether its folder's repository has an LFS rule for `.webm`.

Reopen if: apps that keep large binaries in the home repository become common, or the backup host refuses large files (GitHub refuses files over 100 MB).

See: 07bd5db61c, c5df3d2da7, ADR-0856.

## 2026-11-10 · desktop-host · proposed · A Mac app that keeps `epicenter serve` running

Two days after the Epicenter desktop app was deleted, a record proposed a new one: the Epicenter Mac app is `epicenter serve` with a window. It registers a login job that keeps `serve` running, shows a menu bar item for whether it runs, and carries its own `git` and `git-lfs`, but adds no actions, storage, or sync. None of it is built, and the launcher page its window was meant to show no longer exists in `serve`.

Reopen if: a person who does not use a terminal needs to start and watch `serve`, or keeping it running by hand becomes a burden for the owner.
<!-- review: the record is still Proposed and gives no trigger; the condition is inferred -->

See: ADR-0865, ADR-0941.

## 2026-11-11 · monorepo · adopted · The owner's apps leave this repository

On November 10, new versions of Capture, Tasks (the successor to Todos), and Vocab that run on `epicenter serve` replaced the frozen folder-sync versions in `apps/`. A day later we deleted them and Reading from the monorepo, because each now lives in its own repository in the owner's `~/Epicenter`, where it runs. The copies here were older SvelteKit versions that nothing built or tested, and a second home for each app that would drift. The monorepo kept the platform only, and a change to the library is no longer checked against these apps here.

Reopen if: the library needs a real app in this repository to test against and someone keeps it building in CI; ADR-0969 later answered this with tests that build their own apps.

See: 026b8fd56d, 60edfd6291, ADR-0877.

## 2026-11-11 · ui · proposed · `packages/ui` becomes a shadcn-svelte registry an app copies from

Monorepo apps import `packages/ui` through a workspace link, which an app in an owner's Epicenter cannot do. We planned to publish the kit as a shadcn-svelte registry, so an app copies components into its own view the way shadcn-svelte intends. Only the check that each stock component is upstream's text plus at most one patch is built; there is no registry file, build script, or route.

See: 0e149e978b, ADR-0874.

## 2026-11-12 · mcp · dropped · Claude.ai and ChatGPT connectors stop reaching a home

On 2026-11-11 `serve` gained a second, public listener where Claude.ai and ChatGPT connectors signed in through OAuth and Better Auth, approved on a page only the owner's tailnet reached. The next day we removed it: the owner reaches every app over the tailnet and drives Claude Code on the server from a phone, the connectors were its only callers, and it was about 2,700 lines with four Better Auth dependencies. `serve` signs no one in, and who reaches it is its host's decision. Claude.ai, ChatGPT, Claude's mobile app, and Claude routines cannot reach an Epicenter.

Reopen if: someone needs a connector to reach a home; the record says it would be a separate program in front of `serve`, not part of it.

See: ADR-0883, ADR-0871, 7959c24236.

## 2026-11-12 · npm · adopted · Every earlier `@epicenter` npm release is unpublished

The `@epicenter` scope on npm held packages from the folder sync product and earlier experiments: `cli`, `ui`, `workspace`, `sync`, `filesystem`, `skills`, `opencode`, `field`, `identity`, and `encryption`. We unpublished all of them instead of deprecating them, because deprecated releases stay installable and would describe a product that no longer exists under the names current packages use. The rule since then is to publish a package only when a named consumer outside the monorepo needs to install it. npm never reuses a version, so a future release of an old name takes a version none of its earlier releases used.

Reopen if: a named consumer outside the monorepo needs to install a package, and the owner gives an explicit go for that release.

See: 817bc728b1, ADR-0875.

## 2026-11-13 · merging · refused · Each set of records has one writer, and Epicenter never merges two copies

Earlier drafts sorted apps into classes, each with its own machinery for mirrors, outboxes, and merging. A look at the owner's real apps showed that truth belongs to each set of records, not to the app: Mail's decisions are files in the folder, while the mail itself stays in Gmail. We set one rule: each set of records has one place that may write it, and Epicenter never reconciles two writable copies. We refused to build conflict merging; whoever holds the folder writes files, and everyone else asks an action.

Reopen if: two places must write the same records and neither can ask the other through an action.
<!-- review: inferred; the source gives no reopening condition -->

See: ADR-0896, ADR-0898.

## 2026-11-13 · folder-sync · dropped · The folder sync product is retired

Six days earlier we had said the folder sync product "waits", which left its records marked as accepted and its design open to revival. Asked whether to return to it, the owner said to retire it. Every record that designed it is closed, and its code stays only in the `folder-sync-product` Git tag as history. A later product that needs sync, sharing, or a server must make its own case from its own evidence.

Reopen if: a later product needs sync, sharing, or a server, and makes its own case from its own evidence.

See: ADR-0899.

## 2026-11-13 · whispering · adopted · Whispering 8 is a clean rewrite that needs no Epicenter

Unreleased Whispering had been rebuilt on the folder sync product, with sign-in and a folder on our server. We chose a clean break: Whispering 8 is a new install that keeps recordings and their audio as plain Markdown and audio files in its own folder, with no Git, no account, and no Epicenter. It imports nothing from version 7; a person who wants old recordings copies their Markdown files. People install it fresh and grant the microphone and Accessibility again.

See: ADR-0894, ADR-0892, ADR-0962.

## 2026-11-13 · yjs · refused · Hosted Notes stores each note as a Yjs document

A proposal that morning put Notes at `notes.epicenter.so`, with each note a Yjs document on every device so two offline edits to one note would both survive, built from the Durable Object room code in the `@epicenter/workspace@0.3.0` tag. The same day we replaced it: hosted Notes is a product beside Epicenter, built only if a month of real use shows the need. The recorded evidence pointed the other way: the owner rarely edits on two computers in a week, and his 3,400-page vault had always been plain files. We gave up answering "can it merge" before "does it happen", and no Epicenter code handles Yjs.

Reopen if: the month records real cases of two devices editing one note before either saw the other's edit.

See: e761d11ef6, 9f5b17ccea, ADR-0897.

## 2026-11-13 · git-sync · refused · A program keeps a Git clone of an app's data and pushes it to the home

How a program on another device reaches an Epicenter had been decided three ways in a week: a clone pushing to `incoming/<device>` with conflicts refused, a copy syncing over SSH, and no copy at all. ADR-0887 settled on a clone: a program that must work offline commits what it writes, pushes to a branch only it writes, and the home merges it in. The same day ADR-0894 withdrew it before anything was built, because a clone needs Git on every device, and a phone or a browser tab has none; Whispering 8 keeps its own folder with no Git instead.

Reopen if: every device a program runs on can run Git, and the program must edit existing records while the home is unreachable.

See: ADR-0887, ADR-0894, ADR-0846.

## 2026-11-13 · hand-over · proposed · A program hands its new records over to the home

With a file syncer, Whispering on a laptop shows only that laptop's recordings, and an edit made on the home leaves the laptop's copy unchanged with nothing saying which is right. The proposal splits what the owner wanted: new records cannot collide because each has its own id, so a program may hand each new record, audio included, to the home through the app's `add`; after that the home's copy is the record and every device changes it by asking the home. Only new records wait while the home is unreachable; editing an existing record offline is not offered. A broader draft that made queued actions the rule for every connected program was withdrawn as fitted to Whispering alone.

Reopen if: still open. It waits on an `add` that answers done when sent twice, files beside a record, and action input that can carry audio, as its Unbuilt line lists.

See: ADR-0900, 567ee91679.

## 2026-11-13 · messages · dropped · Messages stops being a standalone program

Messages, the owner's app for drafting chat messages through Beeper, ran as its own local server with a `/beeper` protocol and its token in the Keychain. We retired that program, and Messages became an app in the owner's Epicenter: its actions run in `epicenter serve`, its drafts and send attempts are records in `data/`, and its Beeper token is a local file. The local server, its protocol, and its Keychain store were deleted. The commit states where Messages went, not why the standalone form lost.

Reopen if: Messages has to run on a computer with no Epicenter or without `serve`.
<!-- review: no reason is recorded beyond the move itself; the reopen condition is inferred -->

See: 026a28daed, ADR-0870.

## 2026-11-13 · notes · proposed · Hosted Notes waits for a month of evidence

The owner wants an Apple Notes-like app at `notes.epicenter.so`, for themself and for customers, with every note on a phone offline and editable on two devices. The records point the other way: the owner rarely edits on two computers in a week, and their real notes are about 3,400 files that they and their agents edit directly. We decided Hosted Notes would be a product beside Epicenter, not an Epicenter app, built only if a month of serving those notes from the home to a phone shows the need. If built, it keeps each note as a Yjs document only if the month shows real collisions.

Reopen if: the month records two devices editing one note before either saw the other's edit, or times the phone could not reach the home when the owner wanted to write.

See: ADR-0897.

## 2026-11-13 · tab-manager · refused · Tabs does not come back as a browser extension

After the tab manager extension was deleted in August, records from November 3 and 4 planned its return as Tabs: a WXT extension that read open tabs live and saved tabs as items in a collection, written through the local Epicenter engine on the desktop. None of it was built. The plans closed with the folder sync product they depended on. The saved tabs lost in August were never recovered.

Reopen if: the owner wants saved tabs again and an extension can hand them to an action in their Epicenter.
<!-- review: no record argues against Tabs on its own merits; it closed because its platform was retired; the reopen condition is inferred -->

See: ADR-0743, ADR-0745, ADR-0899.

## 2026-11-13 · updates · adopted · Whispering 8 reads updates from its own address, and v7 is told it is current

Whispering 7 checks `releases/latest/download/latest.json` on GitHub and shows "Failed to check for updates" when the check fails. We decided Whispering 8 is a new install, `so.epicenter.whispering`, that reads `whispering.json` instead, and that each Whispering 8 release also carries v7.11.0's own `latest.json` unchanged, so every v7 install reads that it is up to date. We refused updating v7 in place, which meant reading v7's WebView storage and an untested Windows installer path, and refused a v7.12 bridge release. People move to v8 by downloading it and granting the microphone and Accessibility again.

Reopen if: many v7 users never learn that v8 exists, so a bridge release or an in-place update becomes worth its cost.

<!-- review: this overlaps the existing "Whispering 8 is a clean rewrite" entry, which also cites ADR-0892; keep only if the update-address detail earns its own entry. The release workflow and `whispering.json` are unbuilt as of 2026-11-18 per the triage. -->

See: ADR-0892.

## 2026-11-13 · v7-import · refused · Whispering 8 does not import from Whispering 7

ADR-0892 planned an "Import from Whispering 7" button that copied v7.11's Markdown recordings into Whispering 8's folder. The same day, ADR-0894 cut it: a person who wants their v7 recordings copies the Markdown files, and Whispering 8 carries no code that reads v7's storage. The stated reason is that reading v7's WebView storage buys a clean break its author does not need. Recordings v7 kept in IndexedDB before it wrote files cannot reach v8 at all.

Reopen if: people other than the author ask to bring their v7 recordings into v8 and copying files by hand proves too hard for them.

<!-- review: the reason is one line in ADR-0894's alternatives. The existing history entry "Whispering 8 is a clean rewrite" says v8 "imports version 7.11's recordings when asked", which ADR-0894 and the README ("importing from Whispering 7" under not supported) contradict; that entry may need a correction. -->

See: cdd7646c2c, 6c7212ba88, ADR-0894.

## 2026-11-14 · hosting · refused · The home is a computer its person controls, and Epicenter builds nothing for hosting

Several records had left room for "Epicenter Cloud", a hosted computer a person could pick instead of their own. We decided the home is a computer the person controls, owned or rented, and that the program is built for one person's computer. Nothing in it is for a hosting service: no sign-in in front of `serve` and no per-caller limits. Whoever provides a rented computer can read it, and Epicenter adds no protection against that.

Reopen if: people who cannot keep a computer of their own running become the people Epicenter is for.
<!-- review: inferred; the source gives no reopening condition -->

See: ADR-0903.

## 2026-11-14 · repository · adopted · An Epicenter is one private Git repository

Each app had been two repositories, one for code and one for records, inside a third that listed them; nine apps meant nineteen repositories. Epicenter made a commit for every action call and offered its own history, undo, sync, and update commands. We moved to one private repository that holds every app's code beside its records, committed by the person when they choose. We dropped per-call commits and updating an app by merging from the app it was copied from.

See: ADR-0910, ADR-0940.

## 2026-11-14 · notes · dropped · Honeycrisp is deleted

Honeycrisp, an Apple Notes-style app, had been the maintained notes product since July, one codebase for web and desktop, later moved onto plain files. It belonged to the folder sync product that had just been retired, and nothing in Whispering, the API, or the website imported it, so we deleted it. The tag `before-0891-layout` marks the last commit with it. The owner's notes stay files they and their agents edit, and a hosted notes product waits for evidence.

Reopen if: the Hosted Notes month of evidence shows the need; ADR-0897 then designs a new product rather than restoring this code.

See: 44610c1ca9, ADR-0087, ADR-0902.

## 2026-11-14 · books · dropped · Local Books is deleted

Local Books mirrored the owner's QuickBooks data into a local database it could query with SQL, ran live reports, and made one approved write: recategorizing an expense. It had shipped as a standalone command line tool since June. It belonged to the retired folder sync product and nothing imported it, so we deleted it in the same commit as Honeycrisp. We gave up asking an agent questions about the books from this repository.

Reopen if: the owner wants their books queried again; it would be an app in their Epicenter that calls QuickBooks through actions, the way Mail leaves mail in Gmail.
<!-- review: the commit gives the shared reason for three deletions; whether Local Books was in use at the time is not recorded; the reopen condition is inferred -->

See: 44610c1ca9, ADR-0072, ADR-0902.

## 2026-11-16 · serve · refused · `serve` listens only on this computer

`serve` signs no one in, yet a flag let it listen on any network address, and two earlier designs gave it a public address with passkeys and OAuth. We made `serve` listen only on the local machine, with no flags. Reaching it from a phone is the job of the owner's private network, for example Tailscale. We gave up a public address and any sign-in of our own.

Reopen if: reaching `serve` from another device needs more than a private network such as Tailscale gives.
<!-- review: inferred; the source gives no reopening condition -->

See: ADR-0927.

## 2026-11-17 · yjs · proposed · One app may keep a Yjs document and export Markdown

ADR-0943 allows a CRDT to own live edits inside one app, as long as one exporter writes a saved copy into the home and that copy is never edited as a peer; it refuses a collaboration protocol built into Epicenter. The same day a draft spec sketched it: the app relays Yjs updates over its own WebSocket, appends them to a log under `local/`, and a routine exports Markdown to `data/` as the copy that lasts. A lost `local/` costs the edits since the last export. Nothing is built.

Reopen if: the first app that wants shared editing answers the draft's open questions (which editor, how a document maps to Markdown, when export and compaction run) and records the result.

See: ADR-0943, a352e2199d (the draft; deleted unbuilt on 2026-11-19).

## 2026-11-17 · hosted-api · refused · API keys replace the hosted API's OAuth server

With folder sync retired, Whispering was the one product still calling the hosted API, and only for paid models. We proposed cutting the API to an OpenAI-compatible model API plus a dashboard, reached by per-device API keys from Better Auth's key plugin, and deleting the OAuth server, device sign-in, and the Bun self-host server. The reasons: the OAuth clients ran to thousands of lines of rotation logic, an access token cannot be pasted into another OpenAI tool or a `.env`, and the needs that justified OAuth, MCP clients and Git credentials, were gone. The next day the whole hosted API was retired and the plan was abandoned unbuilt.

Reopen if: the hosted API returns; the record's case for API keys over OAuth would apply again.

See: ADR-0950, ADR-0970, 0e277395b3.
<!-- review: abandoned because the API was retired, not rejected on its merits; "refused" is the closest verdict -->

## 2026-11-17 · billing · refused · AI credits charged by what each call uses

Chat cost a fixed number of credits per model per call, so a call of 200,000 tokens cost the same as an average one, and transcription had no bound on a call's length. We proposed charging by tokens or minutes: hold the most a call can cost with an Autumn lock before it, read the provider's usage during it, and settle at the real cost after. API keys would let any OpenAI tool reach the gateway, which made flat pricing easy to exploit. The hosted API was retired the next day and the plan was abandoned unbuilt.

Reopen if: the hosted API returns with AI credits, especially if any OpenAI-compatible tool can call it.

See: ADR-0951, ADR-0970, 9dd8161baa.
<!-- review: abandoned because the API was retired, not rejected on its merits; "refused" is the closest verdict -->

## 2026-11-17 · daemon · dropped · Epicenter stops installing a background job for `serve`

Since 2026-11-11 `epicenter service install` wrote a macOS LaunchAgent so the operating system restarted `serve` after a crash or reboot. Linux and Windows each needed a writer and tests of their own and neither was built, and the Mac app already registered its own job. We removed `epicenter service`: a person starts `serve` and keeps it running like any program, in a terminal, under their own systemd unit or LaunchAgent, or under the Mac app. We gave up a one-command way to keep `serve` alive.

Reopen if: people who are not developers run a home without the Mac app and cannot write their own service file.

See: 5a0ad0d833, ADR-0941, ADR-0878.

## 2026-11-18 · example-apps · dropped · The repository ships no apps

The repository carried example apps, and the front page told a new owner to install one with a single command. Nothing checked the examples, so they drifted from the library, and checking them meant bending the repository around them. We deleted them: a real app lives in its owner's Epicenter, beside its records. A new owner writes a first one-file app from a walkthrough, and no command makes an app or an Epicenter.

Reopen if: something checks example apps against the library on every change, so they cannot drift.
<!-- review: inferred; the source gives no reopening condition -->

See: ADR-0969, ADR-0955, ADR-0958.

## 2026-11-18 · hosted-api · dropped · The hosted API is retired

`api.epicenter.so` handled sign-in, AI, transcription, and billing. Nothing we ship called it any more, since Whispering's sign-in was removed before it was ever released, and keeping it cost a deploy step, a database in the test gate, and a share of every dependency update. We deleted it and its account website. Epicenter now runs no service, and revenue from hosted services waits for a product that needs one.

Reopen if: a product needs a hosted service and earns its revenue.

See: ADR-0970.

## 2026-11-18 · cli · dropped · `@epicenter/cli` is folded into `@epicenter/app`

The `epicenter` command and the library an app imports were two packages, `@epicenter/cli` and `@epicenter/app`, released at one version and kept equal by a peer dependency, a version script, and a structure check. Once an app became a function of its folder, nothing in memory had to be shared between them, so one package needs none of that. We moved the command into `@epicenter/app`, which now carries the `epicenter` binary, and deleted `packages/cli`. The planned npm releases of `@epicenter/cli` were never made.

Reopen if: the command and the library need different release schedules, or an outside consumer needs one without the other.
<!-- review: the reopen condition is inferred -->

See: e62bc4807b, ADR-0960, ADR-0892.

## 2026-11-18 · local-transcription · dropped · The active local model goes, and every request names its model

Once each app ran as its own program, nothing shared the model cache, and ADR-0397 had already restored naming the model on each request. The commands that read or set the active model were granted to no window and called by nothing. We deleted them along with the stored active model, the readiness check, and prewarming the model at the start of a recording. A request for a model that is unknown or not installed now fails as `ModelUnavailable`; the plugin keeps only which model is loaded and when to unload it.

Reopen if: several apps share one local model cache again, which is the case ADR-0180 was written for.

See: 07f6f74afd, ADR-0397.

## 2026-11-18 · transformations · dropped · Transformations leave Whispering 8 until a later release

Transformations had come back in the file-based rebuild on 2026-10-01 as their own page, with saved prompts and result files beside each transcript, plus a post-processing step. We removed the page, recipes, post-processing, their note kinds, and the text model choice, so Whispering 8 only records, transcribes, and keeps both as files. The last version of those pages is kept at the Git tag `whispering-transformations`. People lose any way to run instructions on a transcript inside Whispering for now.

Reopen if: the later Whispering release that the README promises for transformations is planned; start from the `whispering-transformations` tag.

<!-- review: the commit says only that transformations "wait for a later release"; no record gives the reason for removing them from 8.0. -->

See: a7cafb0b27, bd3e961ede.

## 2026-11-18 · whispering-web · adopted · Whispering's browser build keeps its recordings in the browser's private file system

On 2026-08-08 hosted web apps were refused, and by early November Whispering's web build was meant to sign in and keep recordings in a folder on our server. For Whispering 8 the browser build keeps recordings in the Origin Private File System, in the same layout as the desktop's `data/` folder, with no sign-in and no server. It asks the browser to keep its storage, shows how much it holds, and offers export, because a browser may clear it. We refused IndexedDB, since export would then translate records into files and long audio would be stored whole, and gave up Safari before version 26 and keeping a take through a crash or a closed tab.

Reopen if: people need the web build in a browser without `createWritable()`, or browsers start clearing OPFS data that people did not choose to clear.

See: 6c7212ba88, ADR-0894, ADR-0786.

## 2026-11-19 · one-program · adopted · An Epicenter becomes one program composed in its root `epicenter.ts`

`serve` found each app as a folder in `apps/`, with its code and its own records inside it, and each set of records generated actions. Three cases did not fit: files with no app, such as 415 moved articles; files two apps want; and files that should outlive the app that wrote them. We made the root `epicenter.ts` open the home's records once and pass them to every app, which is now a function, and `serve` imports that one module; every action is written by hand. We gave up self-contained apps: an app's type names one home's data, one broken import stops every app, and copying an app does not copy records.

Reopen if: apps must be shared between homes or written by people who do not trust each other; the old containers isolated each app as if a stranger wrote it.

See: 7a4aa065bc, ADR-0971, #2766.
