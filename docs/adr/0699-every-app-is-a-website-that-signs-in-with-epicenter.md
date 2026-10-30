# 0699. Every app is a website that signs in with Epicenter

- **Status:** Proposed
- **Date:** 2026-10-30
- **Supersedes (if accepted):** [ADR-0694](0694-installing-an-app-is-trusting-it.md): there is no installation; access is a grant per site and per repository, enforced by the server.
- **Amends:** [ADR-0693](0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md): `<owner>/<repo>` stays the address everywhere; "every page is on epicenter.so" becomes "every app is its own site"; Epicenter's own pages are the account, repositories, grants and the Files app.
- **Unbuilt:** sign-in with Epicenter, grants and token checks on the server, the consent page; the browser package already holds one copy per repository per site.

## Context

Apps run by others (`whispering.bradenwong.com`) must work at their own address, before and after sign-in. Running every app on Epicenter's origin made installing an app trust it with every repository in the browser; one origin per owner fixed that across owners but not within one, and made work done before sign-up change origins.

## Decision

**Every app is a website at its own address.** It runs Epicenter's browser package, the same engine as everywhere else.

**Each copy is one repository, as in Git.** A first visit is `git init`: a local repository (`me/home`) in that site's own storage, working with no account. Signing in is `git remote add` plus a push: the same repository gains its remote (its server is learned once) and syncs like any unsent work; if the account's home already has data, the two merge by the ordinary rules. Adding a repository is a clone beside it. Switching is navigation between copies; nothing is deleted or mixed on a switch, and a copy is removed only deliberately, with the existing warning for work that exists only there. A copy's remote never changes to another repository.

**An app is a principal, like a person or an agent.** Anything that acts on repositories is granted them, one repository at a time, read or write, and may hold many. A grant is given by a person, limited to what that person can access, kept in their account and revocable there; the server checks every request against the app's token. Granting an app a repository shares all of it: the repository is the unit of sharing for apps as for people. Blob bytes are fetched when opened.

**A page opens one repository, and its URL names it** (`whispering.bradenwong.com/wong/home`); switching is navigation. Before sign-in the address is `me/home`, which redirects to the person's own name after.

**Signing in is one consent page** with the person's home ticked and their other repositories offered; adding a repository later is the same page with one more tick. An app never grants itself: listing and opening are the app's, granting is Epicenter's.

```ts
const epicenter = await connect();               // local-only until signed in
epicenter.repositories();                        // what this site has been granted
await epicenter.requestAccess();                 // Epicenter's consent page
const repo = await epicenter.open('wong/home');  // usually from the URL
```

**`epicenter.so` holds no repositories.** It is the account, consent and grants. Every app is somewhere else, Epicenter's own included (`todos.epicenter.so`, `files.epicenter.so`).

**Agents, the CLI and the desktop app are principals too,** each holding a token for its granted repositories. Losing a grant stops syncing and deletes nothing, as for people. Whether an organization may restrict which sites its members can grant is an organization setting, decided with organizations.

## Consequences

- An app cannot read a repository it was not granted, enforced by the server; the browser keeps each site's storage apart.
- Each app keeps its own copy of the repositories it uses (mostly text; bytes on demand).
- One consent per site per repository.
- An app's author can change its code at any time; grants bound what it reaches.
- Epicenter's own apps are ordinary sites (`todos.epicenter.so`) that sign in the same way.

## Considered alternatives

- **Apps installed on Epicenter's origin, trusted with everything** (ADR-0694): one shared copy, but any installed app reads every repository in the browser.
- **One origin per owner, apps belonging to owners:** separation across owners only, a sign-in per owner origin, and pre-sign-up work changing origins.
- **Partial copies (an app downloads only its folders):** saves little, since text is small and bytes are fetched on demand, and introduces folder permissions, an exception to the repository as the unit of sharing.
