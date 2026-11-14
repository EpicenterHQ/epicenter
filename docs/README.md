# Documentation

This directory contains knowledge articles, guides, and reference materials for Epicenter.

## Start here

- [Vision](vision.md): what Epicenter is and the rules it keeps, on one page: a home you control, apps as folders of files, and `epicenter serve`.
- [Decisions (ADRs)](adr/README.md): the record of durable decisions and why, each with its status and what is not built yet. Trust this over any spec.
- [The `epicenter` command](../packages/cli/README.md) and [what an app imports](../packages/app/README.md): how the current product works in code.
- [Positioning](positioning.md): canonical public claims and vocabulary rules.
- [Trust model](trust-model.md): who can read your files, decided by who can read the home.
- [Context](CONTEXT.md): the retired folder sync product's vocabulary, for the code of it still here.
- [Architecture](architecture.md): a map of the retired folder sync product's code.
- [Spec history](spec-history.md): a dated index of every spec ever written (history, not current truth).

## Directory structure

### `/articles`
Technical articles and write-ups explaining specific concepts, implementations, or solutions.

### `/architecture`
High-level architectural documentation and system diagrams.

### `/blog`
Blog posts and longer-form content.

### `/guides`
How-to guides for specific tasks or integrations.

### `/patterns`
Documented coding patterns and best practices used in the codebase.

### `/assets`
Static resources (images, demos) used throughout documentation.

### `/launches`
Launch campaign materials and planning documents.

### `/release-notes`
Version release notes used by the CI/CD pipeline.

### `/adr`
Architecture Decision Records: the authoritative, immutable record of durable decisions. See [adr/README.md](adr/README.md) for the template and rules.

## Authority and specs

Durable decisions live in [`adr/`](adr/README.md), today's vocabulary in [the vision](vision.md) under "The pieces", and current state in the code and package READMEs. These are authoritative.

Specs at `/specs` (repo root) are in-flight scaffolding, not current truth: they plan work that is underway and are deleted once their decision is harvested into an ADR. See the [specs README](/specs/README.md) for the workflow, and [`spec-history.md`](spec-history.md) for the dated index of past specs. When a spec disagrees with an ADR or the code, the ADR and code win.
