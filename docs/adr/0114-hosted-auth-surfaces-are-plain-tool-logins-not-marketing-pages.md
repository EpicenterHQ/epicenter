# 0114. Hosted auth surfaces are plain tool logins, not marketing pages

- **Status:** Accepted
- **Date:** 2026-07-07
- **Relates:** ADR-0076, ADR-0088

## Context

The hosted API exposes browser auth surfaces such as:

- `https://api.epicenter.so/sign-in`

These pages sit on the API origin, not the marketing site. They are part of the auth system: users land there to sign in, consent to a client, or complete a CLI/device flow. The page needs to feel trustworthy at the moment a user grants access, but it should not become a second product homepage.

The visual direction for the hosted sign-in page was intentionally shaped by two references:

- Claude Code artifact: `https://claude.ai/code/artifact/e258decd-92aa-4776-ac2c-666b80397bd6`
- Tailscale login: `https://login.tailscale.com/login`

The references matter for their shared traits: a compact centered card, low-noise hierarchy, provider-first action, little or no marketing copy, and a page that feels operational rather than promotional.

This matches ADR-0088: sign-in adds hosted capabilities to a local-first app, but it is not the primary product surface.

## Decision

Hosted Epicenter auth surfaces should look like plain tool login pages, not marketing pages.

The default shape is:

- centered auth card
- minimal chrome
- quiet monochrome hierarchy
- provider-first sign-in action
- no feature pitch
- no marketing navigation
- copy that explains the immediate auth task

The hosted auth shell may carry the Epicenter mark and enough brand continuity to reassure the user that they are on the right origin. It should not carry landing-page structure, product positioning, testimonials, screenshots, broad navigation, or conversion copy.

## Consequences

The sign-in page may look intentionally understated compared with `epicenter.so`. That is correct. The auth origin is a trust and task surface, not a conversion surface.

Design changes to hosted auth pages should preserve the operational login feel unless a later ADR changes this direction.

External reference URLs may change or disappear, so this ADR records the durable design traits in words rather than relying only on links.
