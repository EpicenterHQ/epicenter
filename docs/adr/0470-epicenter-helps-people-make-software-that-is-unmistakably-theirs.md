# 0470. Epicenter helps people make software that is unmistakably theirs

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [Independent applications](0449-epicenter-connects-independent-applications-through-personal-data.md), [file authority](0450-current-files-own-portable-document-data.md), [SQLite storage roles](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md), and [publisher identity](0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md).
- **Unbuilt:** adoption of this positioning in public materials, the file-authoritative application foundation, and access to personal data folders from independently published browser apps.

## Context

Coding agents make personal apps easier to create and change. A person can
build a small tool for their own workflow, then redesign or replace it as their
needs change. The data accumulated through that tool needs to survive those
changes. Regenerating an interface should not require starting its data over.

Epicenter's earlier articulation put a person's digital life in a folder of
plaintext and SQLite, with applications working over that data. The personal
software direction gives that ownership a concrete purpose: people can change
the software they use while keeping their files.

The person making an app can also be its first user. Publishing it lets other
people use the software with their own data. Personal use provides value before
anyone shares an app or an ecosystem of publishers exists.

## Decision

**Epicenter uses this product articulation:**

> **Make software that’s unmistakably yours.**
>
> Keep your data in Markdown and SQLite files you own. Use our apps, someone else’s, or build your own.

**Epicenter provides a foundation for personal apps whose data survives changes
to the software.** A person can redesign, replace, or share an app while keeping
their saved files. The headline expresses the freedom to shape software around
their own workflow. The supporting copy explains data ownership and the choice
of apps. Use this wording when presenting the overall product; individual apps
explain the particular work they help a person do.

The initial customer hypothesis is a person using a coding agent to build or
adapt an app for themselves. Epicenter earns adoption by making saved data
dependable, inspectable, and reusable across compatible apps. Data definitions,
source-preserving edits, and reliable saves must provide enough benefit over
simply asking an agent to write files into a folder.

An app's publisher and its user's data owner are distinct. Publishers can offer
apps at their own domains. Each person uses those apps with their own data;
publishing software does not publish the user's files. Braden's apps at
`*.bradenwong.com` demonstrate the same model available to other publishers.

The copy names the available file formats without assigning them identical
storage roles. Portable document data lives in Markdown rows, `kv.json`, and
attachments. SQLite supplies derived query indexes or justified local
transactional storage. A generated index remains rebuildable from its files.

Compatible apps can reuse a data folder. Different formats require explicit
migration that preserves the originals. Browser access, synchronization,
permissions, and deployment mechanisms need their own contracts and evidence
before public materials describe them as available features.

## Consequences

Public explanations connect the ease of creating software to the need for its
data to last. The first product proof follows a person building an app with a
coding agent, saving real data, and redesigning or replacing the app while
continuing to use the same folder. Publishing that app should let another person
use it with their own files.

Application examples and starter projects should help a person build something
useful for themselves. Whispering and Vocab demonstrate the foundation and
provide starting points. Sharing an app extends that value without requiring a
marketplace.

Customer evidence must show people using their own generated or adapted apps
with these folders and retaining their data through subsequent app changes.
Interest in the wording alone does not establish demand for the foundation.

## Considered alternatives

- Lead with managing a digital life in plaintext and SQLite. This describes
  storage but leaves the freedom to choose and shape applications implicit.
- Use the headline alone. It leaves "yours" unclear: appearance, source code,
  workflow, and data ownership can each mean something different.
- Lead with an app marketplace. Personal software has value for its first user
  before distribution or a population of third-party publishers exists.
- Provide only a folder convention. Agents can already write ordinary files;
  Epicenter must earn its place through dependable saves and reusable data
  contracts that support changing applications.
