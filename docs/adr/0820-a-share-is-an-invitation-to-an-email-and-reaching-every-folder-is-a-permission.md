# 0820. A share is an invitation to an email, and reaching every folder is a permission

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at "A person shares a folder with people": a share names an email and waits as an invitation; at "Any member may be an owner": members are equal, no member owns a folder, and a reader only reads; at "An app reaches the folders attached to it": a program granted `folders:all` reaches every folder the person holds, and only such a program attaches a folder to an app.
- **Relates:** [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) (the CLI's operations), [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) (the Epicenter app has every folder open), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) (consent).
- **Unbuilt:** invitations to an email that has no account, and their acceptance at sign-up; `folders:all` shown at consent; members and readers replacing owner, writer, and reader.

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

**Members are equal, and a reader only reads.** Every member changes files,
shares, unshares, and changes roles; a reader syncs without pushing and manages
nothing. No member owns a folder, so none has to hand it on when they leave.

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
- No folder is stranded by an owner's departure, because none has one.
- Existing CLI sign-ins sign in again to gain `folders:all`.
