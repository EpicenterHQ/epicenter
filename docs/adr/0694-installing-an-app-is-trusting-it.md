# 0694. Installing an app is trusting it

- **Status:** Accepted
- **Date:** 2026-10-29
- **Revisits:** [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md): opening a site's URL still starts installation, and the site's code is served from what was installed.
- **Relates:** [ADR-0693](0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md) (where apps run); [ADR-0680](0680-rust-serves-each-installed-app-from-a-pinned-build-on-its-own-origin.md) (pinned builds on desktop); [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md).
- **Unbuilt:** installing an app another host serves (fetching its manifest and module from `https://<hostname>/`), and serving what was installed pinned to its hash (first-party bundles record a source hash that nothing enforces yet). Built: the `mount` contract (`@epicenter/app`), routing to an app by its hostname, the installed-app record, and the Files app; Todos, Honeycrisp and Files are compiled into the web shell as bundles.

## Context

Apps could be trusted by origin (each on its own site, syncing its own copy,
with tokens scoped by repository) or trusted at installation (running on
Epicenter's origin over every repository). The first doubles storage and
sync per app, needs a consent screen and a sign-in per app, and leaves apps
unable to share data on the web without an account. Git suggests the second:
anyone with access runs whatever tools they like on their own copy.

## Decision

**An app is a static bundle anyone can host:** a manifest with its name and
its collections, and a module exporting `mount(element, { repo, path, navigate })`.
The shell owns the URL; `path` is everything after the app's name, and the app
owns its own routes. Apps need no particular framework.

**An app is identified by the HTTPS hostname it is served at the root of**
(`honeycrisp.epicenter.so`, `recipes.pages.dev`): unique without a registry,
and a link naming an app can offer to install it from there. One app per
hostname. A build from source or `localhost` is a different hostname and a
different app.

**Installing an app means trusting it with everything you can open in that
browser or on that device.** Collections are typed views of files, not
permissions; every app also has the plain file API. Installation is
deliberate, so trust is earned where it is checked:

- **A version is pinned by its content hash.** An app cannot change its code
  silently; an update is a new hash the person approves.
- **The source is one link away,** and an open-source app can be rebuilt and
  compared with its hash.
- **Installed apps belong to the person,** kept in an account record (on the
  device before sign-in) that only the person changes, at `/me`. A file in a
  repository would let anything that writes files install code.

**Our own apps have no separate path.** A new home starts with Files,
Todos and Honeycrisp installed by the same mechanism. Files presents a
repository as folders and files, and is where any link falls back when its
app is not installed.

**Fine-grained scopes exist only for tokens,** where a credential sits on a
machine nobody watches (an agent's server, CI).

## Consequences

- One install method; no app registry, no manifest store, no consent per
  repository, no sign-in per app.
- An installed app can read every repository in that browser and act as the
  person. A family trusts the apps each member installs, as it trusts each
  member's computer.
- A link names an app; a recipient without it is offered the install or
  Files.
- An app served under a path (GitHub Pages project sites) cannot be
  installed until it has a hostname of its own.

## Considered alternatives

- **Every app on its own origin with repository-scoped tokens:** storage and
  sync per app, consent and sign-in per app, no sharing without an account.
- **A sandboxed iframe bridge with per-folder grants checked in the shell:**
  a second enforcement point for a promise installation already makes.
- **Short app names:** readable, but not unique and not installable from a link.
- **Reverse DNS** (`so.epicenter.honeycrisp`): unique, but not fetchable.
- **A registry of names:** a central authority for a problem DNS solves.
- **Installed apps listed in `settings/apps.md`:** any write token would become
  a way to run code.
