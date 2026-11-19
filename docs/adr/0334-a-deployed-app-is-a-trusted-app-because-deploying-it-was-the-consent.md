# 0334. A deployed app is a trusted app, because deploying it was the consent

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) at its two third-party clauses, which are withdrawn: that a self-claimed app id is "not sufficient for third-party code," and that admitting such code "needs an isolation boundary this record does not provide." No boundary is coming. Everything else in that record stands, and this one is its conclusion.
- **Supersedes:** ADR-0305. Its deferred questions, acquisition, artifact trust, app identity, and capability authority, all resolve to the same answer: the person deployed it. There is no catalog plane left to build.
- **Relates:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), ADR-0179, and [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md), which each said a version of this already; [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (whose mechanism half this makes dead); [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) (the option for code you do not want to trust)
- **Unbuilt:** the deploy verb. There is no `epicenter deploy`, no user bundle hosting, and no install plane on desktop. What this record settles is what those will and will not promise when they exist.

## Context

Four records have said a version of this and none has said it plainly. ADR-0118:
ids "separate their data logically, not as a sandbox or security boundary."
ADR-0179: "do not describe the capability file as a sandbox." ADR-0201, refusing
inter-app grants: "a lock with no door... shipping a lock with no door is less
honest than the rule." ADR-0326: the app id is "a coordinate, not a boundary."

Each then carved out third-party code as a case some future record would solve
with a boundary. Designing that boundary produces the same result every time: a
permission model whose enforcement point is on the person's own machine, where
the code being restrained is already running as them.

What is left when the boundary is refused is the act of installing. It is
deliberate, effortful, and made once, by a person who chose a source. That is
better evidence of consent than a dialog answered in half a second while trying
to do something else.

## Decision

**An app a person deployed runs as that person. Whoever wrote it.**

There is no admission plane, no grant, no scope, no capability manifest, and no
runtime permission prompt. **Deploying is the consent**, and it is the only one
asked for.

**The isolation is nominal, and the record says so.** An app id partitions
storage by naming, not by enforcement: a directory on desktop, an address
segment in a browser (ADR-0324). The app id in a broker request is self-claimed,
so an app that claims another's id reaches that app's SQLite files and its
secrets. This is the same posture the desktop has always had; what changes is
that it now covers code Epicenter did not write.

**The enforcement is the person's choice of what to deploy.** That is the whole
mechanism. It is the model every package manager on a developer's machine uses,
and it works there for the same reason: a person picks a source they have reason
to trust, and nothing pretends to protect them if they pick badly.

**The graduated option is not a smaller grant. It is a smaller surface.** An app
somebody is unsure about does not get restricted permissions; it gets to be a
text application (ADR-0329, ADR-0330), which reads and writes files in a
directory and holds no account, no store, and no credential. Its trust is
bounded rather than absent: under ADR-0329 a frontmatter write propagates into
the store and syncs, so a text application can set a value on every row it can
see. What bounds it is that it reaches values and never a body, never a
credential, and never an authority directly, and that its work is a file change
a person can read. Choosing it is choosing a different kind of program, not a
setting.

## Consequences

- **What is deleted, or never started.** Per-app origins, a custom
  `epicenter://` scheme, per-app loopback ports, and the WKWebView storage
  experiment they needed: none are required, because they were purchasing a
  boundary this record refuses. ADR-0305's catalog plane: superseded. A
  server-side bearer scoped to a manifest: not built, and see below.
- **`admitData` and `TRUSTED_DEFINITIONS` become dead**, and have since been deleted along with the `data-open` verb and its client round trip.
  The table is empty by design, its one caller answers 404 to every desktop
  `data-open`, and the only store consumer, Honeycrisp, bypasses the protocol
  entirely. Its stated job was preventing a store "under an address no host verb
  can reach," and ADR-0226 deleted the host's data verbs. ADR-0313's actual
  decision, that a definition ships as TypeScript and an application imports it,
  is untouched and is the shape this record already assumes.
- **Server-side scoping is deferred, not refused.** The authority admits any data
  id under an authenticated principal, and says why: "a signed-in bearer owns its
  own data, and there is no second question to ask." It is also the only party
  that could enforce a scope, because a client provably cannot. It has no askers
  today. If code that is deliberately less than fully trusted ever runs here,
  this is where that decision goes.
- **The price, stated once, plainly.** One malicious or compromised app owns the
  account: the authority bearer, every application's secrets and SQLite files
  through a self-claimed id, and sign-out. There is no containment and none is
  promised.
- **What this depends on for its honesty**, and the day it stops being true is
  the day to reopen: distribution stays "a person chose a source." Homebrew's
  model survives because a formula comes from a tap with a name and readable
  source. A browse-and-one-click store of unreviewed strangers is a different
  product, and this record would be the wrong one for it.
- Nothing here is a claim about the *quality* of code a person deploys. A
  publisher signature would authenticate an author, and neither this record nor
  any naming scheme provides one. That question outlives ADR-0305.

## Considered alternatives

- **A permission model, granted at install or at first use.** Rejected. Its
  enforcement point is the person's own machine, where the restrained code
  already runs as them; on a shared origin a page holding the session can obtain
  the unscoped credential anyway. It would be a lock with no door, which
  ADR-0201 already refused by name.
- **A build-derived manifest as the security boundary.** Rejected as a boundary,
  kept as ergonomics. A scan cannot bind a bundle: the definition brand is
  "declared, never assigned," and on a shared origin `openData` is not even the
  door, since an address can be opened directly. Derivation makes an accurate
  install screen for an honest author and nothing more, and an ADR claiming
  otherwise would ship a false invariant.
- **Per-app origins, so the browser enforces what we will not.** Rejected once
  storage moved to a per-application address (ADR-0324). What one origin still
  shares is identity, not data, and identity is what this record decides to
  share on purpose.
- **Keep deferring, as ADR-0305 did.** Rejected. The deferral was costing
  design: every question about third-party apps was being answered twice, once
  for the world with a boundary and once for the world without. Refusing is what
  lets the rest of the design be simple.
