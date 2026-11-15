# Library refusal as information

Use friction at a library boundary as evidence about the proposed model.

## The rule

When a library refuses your model, investigate the mismatch before building
machinery to work around it.

Read the library's public surface before reshaping or reimplementing its types,
lifecycle, observers, or options. Remove local machinery that duplicates the
library without adding useful behavior or a necessary boundary. Keep a local
model when the work requires responsibilities the library does not own.

## Why this rule earns its keep

A library's public surface defines the behavior it supports, including details
a local wrapper can silently omit. Its documentation and installed source
establish that contract; they do not decide which model the product needs.

When a helper recreates part of a library protocol, investigate two costs:

1. Behavior the local shape drops or changes.
2. A second protocol that must stay aligned as the library changes.

An intentionally narrower domain API can still earn its place. Name what that
boundary gives its callers and compare the complete result.

## How to apply the rule during a pass

When a finding proposes a simplification that touches a library boundary, before editing:

1. Read the installed public types and source for the behavior being changed.
2. Confirm decisive details in official documentation or upstream source. Use
   the relevant domain skill and DeepWiki when helpful; check the installed
   version before relying on an upstream example.
3. Compare the proposed boundary with using the library directly. If it only
   recreates an existing protocol, remove that duplication.
4. If the boundary owns a domain rule, lifecycle, or useful contract, name it
   and adapt explicitly where the two models meet. If the library cannot
   support a necessary capability, compare changing or replacing the dependency
   with maintaining the workaround.

## What a library refusal looks like

Concrete shapes to investigate before extending a local model:

- You are about to write a custom `Observer`-like type because the existing object "doesn't quite fit." The library already ships an observer.
- You are about to extract a `*Manager` to wrap a library client's session, but the library already owns the session and provides the lifecycle hook you need.
- You are about to copy a library's type into your own package "to remove the dependency" from a leaf module. The leaf module imports the library implicitly anyway; the copy just hides it.
- You are about to add an option named for an implementation step (`refreshFn`, `decryptCallback`). Check whether the library's policy-shaped option (`refresh`, `decrypt`) already expresses the behavior the caller needs.

For each candidate, establish which responsibility the boundary adds. Remove
duplicated protocols, preserve justified domain boundaries, and verify the
required behavior through the resulting callers.
