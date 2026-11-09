# 0638. Epicenter Mail lives at mail.epicenter.so

- **Status:** Proposed
- **Date:** 2026-10-19
- **Relates:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (local apps with optional services).
- **Unbuilt:** applying the mail app's display name, publishing its website, and configuring DNS, hosting, and TLS for the chosen address.

## Context

The mail app needs a recognizable name in downloads and Spotlight. “Mail”
alone is ambiguous beside Apple's Mail app. Whispering already has its own
product name. Both can identify Epicenter as their maker without sharing
the same naming pattern.

## Decision

**The mail app is named “Epicenter Mail” at `https://mail.epicenter.so`.**
Use “Epicenter Mail” for its installed application name, Spotlight display
name, download listing, and website heading. The address is a subdomain of
`epicenter.so`.

**Whispering keeps its product name with “by Epicenter” as its maker endorsement.**
Its installed application and Spotlight name remain “Whispering.” Its website
and About screen may present “Whispering, by Epicenter.” A common maker does
not require every app to use an “Epicenter” prefix or invent a separate brand.

**The chosen address does not provision a service.** DNS, hosting, TLS, and
application configuration remain unchanged by this naming decision. Mail
implementation and launch scope require separate work.
The names leave desktop packaging open: a standalone app or an app opened
by an optional Epicenter host can use the same branding.

## Consequences

- Epicenter Mail uses the company name to distinguish a functional app name;
  Whispering retains its existing identity. Paperbird remains an unselected
  naming alternative.
- Product names and addresses do not require an Epicenter launcher or account
  for local use. Service connections follow ADR-0633.
- Display names do not rename existing application identifiers, local data
  stores, or browser origins. Any future change to those needs its own
  migration plan.
- The mail address can remain stable if its displayed brand changes later.
  Todos and other apps have no naming decision imposed by these two choices.

## Considered alternatives

- **Mail.** Shorter, but does not distinguish the installed app from Apple's
  Mail.
- **Paperbird, by Epicenter.** Offers a separate personality, but the chosen
  name communicates both the maker and the function directly.
- **Epicenter Whispering.** Adds a prefix without a reason to replace the
  existing product name.
- **A uniform prefix for all apps.** Makes naming consistent at the cost of
  requiring unrelated products to follow the same pattern.
