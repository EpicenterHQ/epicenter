# Positioning

Canonical positioning for Epicenter. This doc owns the public claims and the rules for deriving copy from them. Finished copy belongs to the surface that ships it: README, landing page, GitHub About, package metadata, or launch plan.

## The Destination

The product picture all messaging derives from. This section describes the end state, not public copy. Public copy quotes the Spine. The Destination is the compass, never quoted directly.

One folder on your disk is one app. Drop an `epicenter.config.ts` into a folder
and that folder becomes an Epicenter app; its name is your choice. The config
default-exports one app, and that app's read-only Markdown projection, its
machine state, and its sync all run from that one folder. A workspace is the
folder where you keep those app folders side by side with the folders you own:

```txt
~/workspace/
|-- apps/
|   |-- whispering/
|   |   |-- epicenter.config.ts   default-exports the whispering app
|   |   |-- recordings/           read-only Markdown projection of live app state
|   |   `-- .epicenter/           machine state; ignore it
|   `-- tabs/
|       |-- epicenter.config.ts   default-exports the tabs app
|       |-- saved/                read-only Markdown projection of live app state
|       `-- .epicenter/           machine state; ignore it
|-- journal/                      yours forever
|-- ideas/                        yours forever
`-- publish/                      yours forever
```

Each app is its own folder, so each runs its own daemon and is its own sync
peer; nothing multiplexes. Group the app folders however you like: the `apps/`
container is convention, not a rule, and nothing reserves the name. Your own
folders (`journal/`, `ideas/`, `publish/`) sit beside them as plain files you
keep forever.

You speak a thought into Whispering and it lands in your Whispering app folder as Markdown. You save tabs, draft entries, capture whatever, each through a purpose-built app, and every capture becomes a file you can grep. An agent reads the same files, queries the SQLite mirrors with plain SQL, and when it needs to change app state it goes through the same gate you do: a workspace action, validated against the app's schema and exposed to the agent as a tool. Nothing mutates by editing generated files; the projection is one-way on purpose.

The loop is capture, curate, keep. App output is a disposable inbox, regenerable from the CRDT at any time. What matters graduates into folders you own: ordinary Markdown, tracked in git, still yours after every app in this repo is gone.

The quiet bet: the properties that make a workspace durable for you are the same ones that make it legible to agents. Plain files are the context window. SQLite is the query surface. The action registry is the tool list. Epicenter is the workspace where you and your agents are co-writers under one set of rules.

What we refuse to build is the strategy. No partial sync: a workspace is one full local replica, which is what lets Yjs carry it instead of a private protocol. No row-level permissions: the app corpus is the unit of sharing; the folder is a local projection and runtime site for that corpus. No editing generated projections back into apps: one validated write path, for humans and agents alike. Each refusal pays for the simplicity of everything else.

## The Spine

One message, cut to length and audience. Longer cuts add detail. No cut contradicts a shorter one, and every claim from a shorter cut survives in the longer cuts.

One line, for one-line surfaces (GitHub About, social preview, link cards):

> Local-first apps that write to files you own.

The hero cut, for the root README hero:

> **Local-first apps that write to files you own.** Your data lives on your machine as plain Markdown and SQLite: grep it, version it, open it in Obsidian. When an app stops mattering, your files don't.

One paragraph, for anyone giving us thirty seconds (website about page, CONTRIBUTING, talk bios):

> Most apps trap your data in their database. Epicenter apps keep live state in CRDTs and project everything to ordinary files on your machine: Markdown you can read and edit, SQLite you can query. When an app stops mattering, your files don't. Start with Whispering, our desktop speech-to-text app; the shared workspace behind it is being built in the open in the same repo.

The developer cut, for `@epicenter/app/store` and other toolkit surfaces (npm, package READMEs, technical talks):

> A local-first workspace engine for TypeScript apps: Yjs as the source of truth, Markdown and SQLite as the outputs.

The public cut, for epicenter.so and other general-audience surfaces:

> Apps come and go. Your files shouldn't. Epicenter apps save everything you make as ordinary files in a folder on your computer, so what matters to you outlives every app that made it.

The developer and public cuts are the only cuts with their own framing. The developer cut exists because npm readers evaluate an API, not a product. The public cut exists because epicenter.so readers are not evaluating an architecture: it restates the one-line cut with the vocabulary translated. Markdown, SQLite, local-first, CRDT, and Yjs stay out of public heroes; on a public surface the mechanism appears below the fold, after the benefit it guarantees, never as the headline. Everything else derives from the user-facing cuts above.

Headlines, tweets, launch posts, and package copy derive from these cuts but live in the surface that publishes them. If a derived surface needs a claim the spine does not make, fix the spine first.

## The Hook

The long-form narrative, for surfaces with room to breathe (landing page body, launch posts, talks). It extends the spine with the claims the short cuts cannot carry: multiple apps share one workspace, and good captures graduate.

Most tools store your data in their own silo. Epicenter gives purpose-built apps a shared local-first workspace: app data can be browsed as Markdown, queried through SQLite, and curated into folders you control. Your folders are ordinary Markdown: grep them, open them in Obsidian, version them with Git, publish them with whatever static site stack you like. Your transcripts can inform your notes. Your saved tabs can become drafts. Good captures graduate into your long-term workspace instead of staying trapped in the app that caught them.

Under the hood, app-owned state lives in Yjs, materializes to SQLite for fast queries, and materializes to Markdown for human-readable projections. Sync happens over the Yjs protocol when you turn it on, through a relay that reads your data in plaintext: hosted Epicenter holds it, and self-hosting puts it on infrastructure you control. Privacy is a topology choice, not an encryption layer.

## The Proof Line

Every shipped surface longer than one line carries exactly one proof line, stated without caveats. The proof line is a claim, not finished copy: each surface writes its own sentence, in keeping with the rule that finished copy belongs to the surface that ships it. The sentence must carry:

- Whispering, by name
- desktop speech-to-text
- you can install it today
- macOS, Windows, and Linux, somewhere on the surface (platform badges or adjacent copy count)

Roadmap language stays out of heroes. "A refresh built on the workspace is in progress" and "being built in public" are Status-section sentences; in a hero they hedge the only shipped product and tell a first-time reader to wait.

## Earned Vocabulary

Some words are internal until the surface earns them. Do not use a term before the reader has seen the thing it names.

| Term | Earned by |
|---|---|
| workspace (the folder) | showing the directory tree first |
| materializer | one defining clause at first use: "materializers, the writers that project state to disk" |
| projection | showing a generated file next to the state it came from |
| validated action | naming the validator: the app's schema |
| workspace-native | never on public surfaces; say "built on the workspace" |

"PKM substrate" is accurate but niche. Use it in technical talks and blog posts, never in a hero or README.

Do not use hype words: `AI-native`, `agentic`, `next-gen`, `revolutionary`, `redefine`, `game changer`, `Web3`, `metaverse`. Do not stack buzzwords. "CRDT-powered AI-first encrypted next-gen offline-first workspace" is a sign to say less and prove more.

## What Epicenter Is

- An **open-source, local-first workspace**: purpose-built apps plus Markdown folders you own
- A **TypeScript library** (`@epicenter/app/store`) for building CRDT-backed apps with typed schemas, materializers, and actions
- A **CLI** (`epicenter`) for running a headless watcher that syncs and materializes one workspace root
- A **sync server** (AGPL, self-hostable) that relays CRDT updates between your devices

## What Epicenter Is Not

- Not a single app (many purpose-built apps share one workspace)
- Not cloud-first (local-first by default, sync is optional)
- Not a Notion or Obsidian clone (it is the workspace layer beneath capture, curation, and publishing tools)

## Core Claims (Verifiable)

Every claim we make publicly should be provable by inspecting the repo:

| Claim | Proof |
|---|---|
| "We ship" | Whispering installs on macOS, Windows, and Linux through normal release channels. |
| "Readable Markdown and queryable SQLite" | Markdown materializers write `.md` files with YAML frontmatter. SQLite materializers keep rebuildable query mirrors. |
| "A workspace you own" | The local project layout separates user-owned folders from generated app projections and hidden machine state. |
| "CRDT-powered sync" | App-owned live state uses Yjs documents; sync uses the Yjs protocol over WebSocket. |
| "Trusted relay, not an encryption layer" | The relay runs Yjs and reads plaintext. Privacy comes from who holds the data, not from a key we ship. See `docs/trust-model.md`. |
| "Self-hostable" | Sync server is open source under AGPL. Run it on your infrastructure, so Epicenter never holds your data. |
| "Bring your own model" | AI features use user-provided API keys. No middleman, no proxy required. |

## Competitor Positioning

### vs Obsidian
> Obsidian is a markdown editor with sync. Epicenter is the local-first workspace where purpose-built apps produce readable projections and curated Markdown stays yours.

- **Win**: App output can become durable workspace material without living in per-plugin storage. CRDT sync instead of file-level conflict resolution.
- **Lose**: Obsidian's plugin ecosystem and years of UX polish. We're earlier.

### vs Anytype
> Anytype is a purpose-built encrypted space ecosystem. Epicenter is the Yjs-backed workspace where apps project readable files and curated Markdown stays yours.

- **Win**: Standard CRDT stack (Yjs, widely adopted and battle-tested) vs custom protocol. Developer-facing API with typed schemas, not just an end-user app.
- **Lose**: Anytype's product is more complete today. Their P2P sync story is more mature.

### vs Logseq
> Logseq is an outliner-first app. Epicenter is the structured local-first storage engine that can power outline UIs without trapping data in a single app.

- **Win**: SQL plus structured schemas. Purpose-built capture tools can project into a workspace you control. Self-hostable CRDT sync.
- **Lose**: Logseq's block/journal UX is more native. Larger community.

### vs Standard Notes
> Standard Notes encrypts your notes. Epicenter is a whole local-first workspace that multiple apps share, with CRDTs, schemas, and materialized exports.

- **Win**: Platform, not just "notes." Structured data with schemas. Materialized to files you can inspect.
- **Lose**: Standard Notes' encryption UX is simpler to communicate. They've earned trust over years.

### vs Notion
> Notion is where your knowledge lives. Epicenter is where your knowledge stays.

- **Win**: Offline-first, local-first, open source, no cloud lock-in.
- **Lose**: Notion's UX, templates, collaboration, and distribution are years ahead.

### vs Karpathy's "Second Brain" System
> Karpathy showed the folder. Epicenter is the local-first app layer around it.

Karpathy's "second brain" post is the strongest entry point: three folders of Markdown, a schema file, and AI organizing everything. Epicenter keeps that philosophy and adds sync, schemas, and CLI actions.

- **Win**: CRDT sync across devices, typed schemas, CLI automation: everything raw folders can't do.
- **Lose**: Karpathy's system wins on simplicity. A folder of markdown files needs zero infrastructure.

### vs Jazz
> Jazz syncs slices of a shared database to everyone. Epicenter materializes one whole workspace into a folder that belongs to you.

The two stacks converged from opposite premises: typed tables, query subscriptions, local-first writes, collaborative text. The difference is scope. Jazz is a multi-user relational database with partial replication and row-level permissions. Epicenter is hyper-focused on personal apps, so a workspace is a full local replica, the unit of sharing is the folder, and we refuse partial sync, row permissions, and snapshotting on purpose. That refusal is what lets us build on Yjs and open standards instead of a custom sync engine. See [the long form](articles/20260531T160000-i-kept-reinventing-jazz-the-win-is-what-we-refuse.md).

- **Win**: One folder you own, plain text and SQLite you can grep without the app, built on standard Yjs rather than a private protocol. Less to learn because the scope is smaller.
- **Lose**: Jazz scales to large shared datasets and multi-user row-level access that Epicenter deliberately won't. For a synced multi-user app database, Jazz is the better tool and further along.

Trigger to split: if Competitor Positioning stops deriving from the spine or grows beyond quick battlecards, move it into its own competitor file.

## Package Copy

Each package's npm description and keywords live in its `package.json`; that file is the owner and this doc does not duplicate it. The rule when writing one: user-facing packages derive from the user cuts of the spine, `@epicenter/app/store` derives from the developer cut, and every description leads with what the package does, not what category it is in.

Trigger to revisit: if package descriptions drift off-spine again, add a check script.
