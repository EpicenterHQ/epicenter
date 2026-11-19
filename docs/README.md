# Documentation

This directory holds the vision, the history of what Epicenter tried and turned down, and a few operating guides.

## Start here

- [Vision](vision.md): what Epicenter is and the rules it keeps: your apps and files on a computer you control and keep on.
- [History](history.md): what Epicenter tried, kept, and turned down, oldest first, and why. Background, not rules.
- Each area's current rules are in a `## Decisions` section of its README, beside its code.
- [What your Epicenter imports, and the `epicenter` command](../packages/app/README.md): how the current product works in code.
- [Positioning](positioning.md): canonical public claims and vocabulary rules.
- [Trust model](trust-model.md): who can read your files, decided by who can read your computer.
- [Spec history](spec-history.md): a dated index of every spec ever written (history, not current truth).

## Directory structure

### `/guides`
One operating guide for a live system: [Whispering redirects](guides/whispering-redirects.md) (the legacy domains and where they point).

### `/licensing`
[Licensing strategy](licensing/licensing-strategy.md): the license, the threat model, and "If MIT returns".

The decision records that `adr/` held until 2026-11-19 are in the annotated `adr-archive` Git tag; [AGENTS.md](../AGENTS.md) shows how to read one. Older writing (launch plans, blog drafts, patterns, release notes, images, and dated reviews) is no longer in this repository. Git history keeps it: `git log --diff-filter=D --name-only -- docs/` finds the removal commit, and `git show <parent>:docs/<path>` restores a file.

## Authority and specs

Current rules live in each README's `## Decisions` section, today's vocabulary in [the vision](vision.md) under "The pieces", and current state in the code and package READMEs. These are authoritative.

Specs at `/specs` (repo root) are in-flight scaffolding, not current truth: they plan work that is underway and are deleted once their decision is written into the README it governs. See the [specs README](/specs/README.md) for the workflow, and [`spec-history.md`](spec-history.md) for the dated index of past specs. When a spec disagrees with a README's decisions or the code, the README and code win.
