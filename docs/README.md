# Documentation

This directory contains knowledge articles, guides, and reference materials for Epicenter.

## Start Here

- [Building a personal app: design guide](guides/personal-apps.md): the target developer journey, unresolved interfaces, and evidence required before it becomes an executable guide.
- [Decisions (ADRs)](adr/README.md): the authoritative record of durable architecture decisions and why. Trust this over any spec.
- [Context](CONTEXT.md): shared vocabulary for the platform's concepts.
- [Positioning](positioning.md): canonical public claims and vocabulary rules.
- [Architecture](architecture.md): the repo's main server, app, package, and deployment boundaries.
- [Trust model](trust-model.md): what the trusted relay reads, the two deployments, and where the anchor is heading.
- [Spec history](spec-history.md): a dated index of every spec ever written (history, not current truth).

## Directory Structure

### `/articles`
Technical articles and write-ups explaining specific concepts, implementations, or solutions.

### `/architecture`
High-level architectural documentation and system diagrams.

### `/blog`
Blog posts and longer-form content.

### `/guides`
How-to guides for specific tasks or integrations, and explicitly labeled design guides for workflows under development.

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

## Authority and Specs

Durable decisions live in [`adr/`](adr/README.md), shared vocabulary in [`CONTEXT.md`](CONTEXT.md), current state in the code and reference docs. These are authoritative.

Specs at `/specs` (repo root) are in-flight scaffolding, not current truth: they plan work that is underway and are deleted once their decision is harvested into an ADR. See the [specs README](/specs/README.md) for the workflow, and [`spec-history.md`](spec-history.md) for the dated index of past specs. When a spec disagrees with an ADR or the code, the ADR and code win.
