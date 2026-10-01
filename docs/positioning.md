# Positioning

This document records the product model and editorial decisions for the completed personal-software direction. The [public-materials plan](../specs/20260930T210607-personal-software-public-materials.md) tracks execution. These target descriptions do not establish current implementation or release availability.

Finished copy belongs to its destination. The [root README](../README.md) owns its approved opening; app READMEs own their product descriptions. Package documentation remains accurate to the code it documents.

## Epicenter

Epicenter is a foundation for building personal apps over Markdown and SQLite files you own.

Applications provide interfaces for capturing, editing, and organizing that data. Markdown documents contain structured fields and text. Attachments remain ordinary files. An optional generated SQLite index exposes records to SQL tools. An app interprets these files rather than requiring an export to make them accessible.

Compatible apps can use the same data. People can modify an interface or build another one without converting compatible data into a new app-specific format. Compatibility requires agreement on formats and definitions; using Epicenter does not make unrelated apps interchangeable.

The foundation supports independently owned applications. An app can have its own repository, releases, domain, and community. The Epicenter desktop host is one way to compose applications, not the required identity or distribution channel for every app.

## Data and software ownership

A person controls the files used by their apps. A publisher distributes software that other people use with their own data. Publishing an app does not publish the files of the people who use it.

Markdown files and their attachments are saved source data. The generated SQLite index is a query snapshot. SQL writes to that index do not edit source files. Private SQLite databases used for caches or pending transactions have separate retention and recovery requirements; they are not all disposable indexes.

App definitions interpret existing files without rewriting them on open. Edits preserve unknown content. Format changes require explicit migrations that retain the originals. Coordinated app saves check for intervening changes; native tools outside that coordination can still race a save.

These distinctions belong in developer explanations when they affect the reader’s decision. A short headline need not enumerate them, but later copy must not contradict them.

## Whispering and other personal apps

Whispering is Braden Wong’s speech-to-text app, built on Epicenter.

> Whispering
>
> Press a shortcut. Speak. Get text.
>
> By Braden Wong. Built on Epicenter.

The intended product home is `whispering.bradenwong.com`; the intended repository is `braden-w/whispering`. Vocab follows the same ownership model at `vocab.bradenwong.com`. Product names and authorship remain visible; the Epicenter attribution links to `https://epicenter.so`.

An app page explains that app’s use, data, and installation. The Epicenter page explains the foundation and helps people discover apps or build their own. Whispering can demonstrate the model without becoming the subject of every Epicenter surface.

Personal publishing addresses such as `alice.epicenter.so` illustrate a possible publishing service. They do not establish domain provisioning, hosting, community tooling, or access to someone’s data. Keep that proposal distinct from independent app ownership.

## Reader and destination

| Destination | Reader’s question | Content |
| --- | --- | --- |
| Epicenter README | What is this, and how does it work? | General technical model, data ownership, compatibility, developer navigation |
| Epicenter landing page | What could I do with this? | Visual explanation, app discovery, route into building |
| App README | What does this app do, and how do I work on it? | Product workflow, publisher, data behavior, development guide |
| Personal app page | How would this help me? | Demonstration, use, verified installation destination |
| Developer journey guide | How do I build an app around these files? | Stages, contracts, acceptance scenarios, unresolved interfaces |
| Package README | What API can I use in this checkout? | Current exports, resource ownership, examples checked against code |

The root README’s approved four-paragraph opening stays verbatim. Its mechanism belongs near the opening because that reader evaluates architecture. Landing-page copy can start with the experience and introduce files through a visual demonstration. It does not need to repeat the README in cards.

## Writing decisions

Name the thing and explain what it does. Use Markdown and SQLite where their meaning helps a technical reader. Explain source files and generated indexes before relying on that distinction. Keep agents as possible users of files and tools rather than the main explanation of the product.

Use concrete mechanisms instead of slogans about ownership. Avoid a single-app anecdote as the general README opening. Do not describe applications as interchangeable without naming compatibility. Do not assign every app a separate daemon, reserve a folder layout, or invent a configuration entrypoint to make the explanation concrete.

Remote inference sends the selected input to its endpoint. Local storage does not imply local inference, encryption, or private hosted synchronization. Describe each data flow on the app surface that owns it; do not use blanket claims such as “nothing leaves your device.”

## Working backward

The [developer journey](guides/personal-apps.md) owns implementation evidence for the file-based foundation. Current [application composition](../apps/README.md) and [package contracts](../packages/app/README.md) explain the existing Yjs implementation. They remain current engineering references until code changes justify updating them.

The earlier positioning described Yjs as saved source and Markdown as a one-way projection. That is a different model from editable source files. Its mandatory desktop-host framing and Whispering-download requirement no longer determine this design. Historical decisions remain in their records; public materials follow the direction selected here.

External publication requires checking product availability, installation links, and the behaviors claimed by the final copy. Writing the finished-product design establishes the destination; it does not supply those checks.
