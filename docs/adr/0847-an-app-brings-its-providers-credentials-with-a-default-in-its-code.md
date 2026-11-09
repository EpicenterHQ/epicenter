# 0847. An app brings its provider's credentials, with a default in its code

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (shared providers stay out of core), [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app's `secrets`).
- **Unbuilt:** all of it; Mail is the first app to follow it.

## Context

Mail signs in to Google with an OAuth client. A person could bring their own
client, or use one Epicenter provides, perhaps through an Epicenter account.
Two versions of Mail, one for each, would double the app for a difference of
one value.

## Decision

**One app; its client is a default with an override.** `connect` uses the
OAuth client stored in the app's `secrets` when there is one (the person's own),
and otherwise the default written in the app's code. Google treats an installed
app's client secret as not secret, so a default needs no broker server and no
Epicenter account. The refresh token `connect` mints lives in the app's
`secrets`, never in its folder.

**A default may be absent.** Mail ships with none for now: a public app with
Gmail's restricted `gmail.modify` scope must pass Google's verification and a
yearly third-party security assessment. Until Epicenter does, each person
brings a client; the author uses the vault calendar's personal Google project,
with the Gmail API enabled.

**Providers stay in the app.** Epicenter's core holds no Google, Beeper, or
other provider client; each app that needs one owns it.

## Considered alternatives

- **Two versions of an app.** Twice the code to keep identical for one value.
- **A broker on Epicenter's server that holds the client.** Needed only for a
  web client that cannot keep a secret; an installed app can embed its client.
- **Reusing Epicenter's sign-in client** (the API's `GOOGLE_CLIENT_ID`). Adding
  a restricted Gmail scope would put Epicenter's production sign-in through
  Google's restricted-scope review.
