# Documentation

This directory holds the vision, the decision records, and a few operating guides for Epicenter.

## Start here

- [Vision](vision.md): what Epicenter is and the rules it keeps: your apps and files on a computer you control and keep on.
- [Decisions (ADRs)](adr/README.md): the record of durable decisions and why, each with its status and what is not built yet. Trust this over any spec.
- [What a home imports, and the `epicenter` command](../packages/app/README.md): how the current product works in code.
- [Positioning](positioning.md): canonical public claims and vocabulary rules.
- [Trust model](trust-model.md): who can read your files, decided by who can read the home.
- [Spec history](spec-history.md): a dated index of every spec ever written (history, not current truth).

## Directory structure

### `/adr`
Architecture Decision Records: the authoritative, immutable record of durable decisions. See [adr/README.md](adr/README.md) for the template and rules.

### `/guides`
One operating guide for a live system: [Whispering redirects](guides/whispering-redirects.md) (the legacy domains and where they point).

### `/licensing`
[Licensing strategy](licensing/licensing-strategy.md): the license, the threat model, and "If MIT returns".

Older writing (launch plans, blog drafts, patterns, release notes, images, and dated reviews) is no longer in this repository. Git history keeps it: `git log --diff-filter=D --name-only -- docs/` finds the removal commit, and `git show <parent>:docs/<path>` restores a file.

## Authority and specs

Durable decisions live in [`adr/`](adr/README.md), today's vocabulary in [the vision](vision.md) under "The pieces", and current state in the code and package READMEs. These are authoritative.

Specs at `/specs` (repo root) are in-flight scaffolding, not current truth: they plan work that is underway and are deleted once their decision is harvested into an ADR. See the [specs README](/specs/README.md) for the workflow, and [`spec-history.md`](spec-history.md) for the dated index of past specs. When a spec disagrees with an ADR or the code, the ADR and code win.
