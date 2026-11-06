# 0820. A share is an invitation to an email, and reaching every folder is a permission

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at "A person shares a folder with people": a share names an email and waits as an invitation; at "Any member may be an owner": a member is an owner, a writer, or a reader, and the earliest remaining member becomes owner when the last owner leaves; at "An app reaches the folders attached to it": a program granted `folders:all` reaches every folder the person holds, and only such a program attaches a folder to an app.
- **Relates:** [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) (the CLI's operations), [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) (the Epicenter app has every folder open), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) (consent).
- **Unbuilt:** none.

## Context

The folder-first pass built ADR-0811: folders whose members are people, shares
that wait for acceptance, and apps that reach the folders attached to them.
Building it settled what 0811 left open: how a person is named when sharing,
what a member may do, who owns a folder its owners have left, and how the CLI
and the Epicenter app, which manage every folder, reach them. Naming a person
by an email that must already have an account answered 404 for any other,
which told anyone whether an email had an account.

## Decision

**A share names an email and is an invitation.** It waits until a person with
that email accepts it, whether they have an account now or sign up later, and
grants nothing before. The server answers a share the same whether or not the
email has an account.

**A member is an owner, a writer, or a reader.** An owner shares, unshares,
and changes roles; a writer changes files; a reader syncs without pushing. When
the last owner leaves a folder others hold, its earliest remaining member
becomes owner, and the last owner cannot step down while others remain.

**Reaching every folder is the permission `folders:all`.** The CLI and the
Epicenter app ask for it, and consent shows it as reaching every folder the
person has. Any other app reaches only the folders attached to it, and only a
program with `folders:all` attaches a folder to an app, so no app attaches one
to itself.

**`epicenter.json` is stored as plain text in the folder's history**, never as
a large-file pointer, so the server reads a folder's title and any clone shows
the contract as written.

## Consequences

- A person can share with someone who is not yet on Epicenter.
- Nobody learns from a share whether an email has an account.
- A folder always has an owner while anyone holds it.
- Existing CLI sign-ins sign in again to gain `folders:all`.
