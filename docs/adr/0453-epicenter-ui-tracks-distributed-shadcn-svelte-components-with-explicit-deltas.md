# 0453. Epicenter UI tracks distributed shadcn-svelte components with explicit deltas

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Apps import components through `@epicenter/ui/*`. Before this migration, the
package vendored shadcn-svelte's `cn-*` authoring source, `style-vega.css`, and
an Epicenter CSS overlay. Upstream's
[registry build](https://github.com/huntabyte/shadcn-svelte/blob/6b5914aac9c142a1eff3604995b3cb94eda2f933/docs/scripts/build-registry.ts)
resolves those hooks into utilities before publishing each style's component
files. A developer using the shadcn-svelte CLI
receives the distributed component, while Epicenter maintains an additional
stylesheet and requires each app root to carry `style-vega`.

Epicenter currently supplies local conveniences to compare with each refresh: `Button` and `Link` accept simple `tooltip` labels, Drawer contains
scrolling content, and components expose variants used
by app callers. A newer upstream implementation may make a local difference
unnecessary. Keeping the upstream authoring format does not eliminate the
work of reconciling those behaviors during an update.

## Decision

**The upstream baseline for a vendored shadcn-svelte component is its generated
Vega registry artifact.** Upstream owns the default visual and interaction
behavior. A refresh may change geometry, animation, focus, or selection policy;
preserving the prior appearance is not itself a requirement.
`packages/ui/src/<component>/` holds the component
that Epicenter apps import through `@epicenter/ui/<component>`. A refresh obtains
a recorded upstream artifact in scratch space, compares it with the local file
and its callers, and integrates the relevant change. shadcn-svelte-extras
components use their own distributed artifacts as the baseline. Running a CLI
against the live package is not an update mechanism.

**Every difference from that artifact has an owner and a reason.** Package
integration adjusts relative imports and icon imports. Epicenter-owned behavior,
variants, accessibility fixes, and visual preferences stay when a demonstrated
workflow or shared theme decision establishes their purpose. Reconsider an old
fix when incoming upstream behavior can provide its guarantee. Existing callers
are evidence to inspect, not a permanent compatibility promise. The package
README records these deltas and a recoverable baseline for each refresh: saved
registry output preserved in Git, or an upstream commit and build inputs that
reproduce the artifact. Shared fonts, semantic tokens, and base CSS stay in
`packages/ui/src/app.css`; app-specific workflow and layout stay in the apps.

**All apps consume the same UI package.** A component update reaches apps
through their existing workspace dependency. Apps do not install or synchronize
separate shadcn-svelte copies. `@epicenter/ui/tooltip` remains public for
non-button triggers and composed content; the `Button` and `Link` `tooltip`
props serve simple labels. Each app supplies one root `Tooltip.Provider` for
shared timing.

## Consequences

The maintained component has a direct comparison with what the CLI installs.
Epicenter still reviews upstream changes against local behavior; a generated
file does not preserve custom props or fixes. A CLI version or mutable registry
URL alone does not pin the response, so the update preserves a recoverable
baseline.

Converting the existing package moved Vega declarations and overlay deltas into
component files. CSS precedence required checking app call sites. For example,
a Dialog caller's unprefixed `max-w-2xl` overrode a base-layer `sm:max-w-md`;
putting both in utility classes changes which width wins. Accept the incoming
default when the workflow remains usable; add a width override only when its
content demonstrates a need. The conversion also ended the root-class preset
mechanism. A
different visual style requires a reviewed component change rather than a class
change.

## Considered alternatives

- Keep upstream's `cn-*` authoring format as Epicenter's permanent format:
  preserves source-level correspondence but retains a second stylesheet,
  overlay coordination, and root activation that the distributed component
  does not require.
- Install shadcn-svelte separately in each app: duplicates component updates
  and Epicenter's tooltip and interaction contracts across consumers.
- Automatically overwrite local files with CLI output: loses deliberate
  package behavior and provides no review of affected app callers.
