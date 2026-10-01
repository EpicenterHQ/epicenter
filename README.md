<p align="center">
  <a href="https://epicenter.so">
    <img width="80" src="logos/source/epicenter-icon-squircle.svg" alt="Epicenter">
  </a>
</p>

# Epicenter

**Make software that’s unmistakably yours.**

Epicenter is a foundation for building personal apps over Markdown and SQLite files you own.

Applications provide interfaces for capturing, editing, and organizing personal data. That data remains accessible outside the applications: as Markdown that text editors and scripts can read, attachments that ordinary tools can open, and SQLite that SQL tools can query.

Compatible applications can work with the same data. You can use an existing app, modify it, or build a different interface without moving compatible data into a new application-specific format.

## Data model

Document data is stored in folders containing Markdown files, settings, and attachments. Markdown frontmatter holds structured fields; the body holds document content. The files are the saved source, so editing them changes the data rather than an exported copy.

SQLite provides a queryable view of a folder’s contents. An optional generated index exposes structured records to SQL tools without requiring them to parse each Markdown file. The index is a snapshot that can be regenerated from the source files. SQL writes to the index do not modify those files.

Applications can also use private local SQLite databases for provider caches or transactional state. These databases have separate retention and recovery requirements. A cache may be rebuildable; pending work cannot be recovered merely by rebuilding that cache.

## Application model

An application declares the data it understands and composes the capabilities it needs. A data definition interprets saved files; it does not migrate them merely because a new version of the application opens them.

Typed edits preserve content outside the intended change. Unknown fields and files that cannot be interpreted remain available for inspection and repair. Saves check for intervening source changes and coordinate writers using Epicenter’s file operations. Native programs outside that boundary can still race a save.

Data compatibility depends on shared formats and definitions. Using Epicenter does not make every application interchangeable. A change of format requires an explicit migration that preserves the originals.

Applications can have their own repositories, releases, and public domains. Shared packages provide the foundation without requiring every application to run inside Epicenter desktop. Publishing an application distributes its software; it does not publish the data of the people using it.

## Development

This repository contains the shared packages, applications, desktop host, and service deployments. Use Bun and start applications from the repository root.

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
```

Start an application with `bun dev:<app>`. App READMEs document their prerequisites, development commands, and build steps.

Run `bun run check` for the repository’s lint, typecheck, test, and structural checks.

- [Building a personal app: target design guide](docs/guides/personal-apps.md)
- [Application composition](apps/README.md)
- [Application package](packages/app/README.md)
- [Hosted API setup](apps/api/README.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture decisions](docs/adr/README.md)

Package READMEs document their APIs and resource contracts.

## License

The applications and packages in this repository are AGPL-3.0-or-later. Previously published MIT versions retain their original license. See the [licensing strategy](docs/licensing/licensing-strategy.md).
