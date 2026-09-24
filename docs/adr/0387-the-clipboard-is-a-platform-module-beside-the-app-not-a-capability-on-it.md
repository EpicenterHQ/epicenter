# 0387. The clipboard is a platform module beside the App, not a capability on it

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amended by:** [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at "permissions the generic trusted app-window capabilities grant": the host grants them to every window. [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) at "selected for the build by a `#platform/clipboard` seam": the package selects the leaf at runtime with `isTauri()`. The module, its two leaves, and the normalization stand.

## Context

Whispering owned the only clipboard code: a browser leaf over the page's
Clipboard API and a host leaf over the Tauri clipboard plugin, both inside its
text service next to cursor delivery and synthetic keystrokes. Its copy buttons,
selection capture, recipe-on-clipboard, and delivery sinks all reached the
clipboard through that service. Other applications had no shared way to read or
write clipboard text, and `packages/ui` carried an injectable copy function so a
host build could avoid the page API.

The first proposal put `readText` and `writeText` on the opened App as
`app.clipboard`, supplied through `ApplicationRuntime` and guarded by the App
lifetime like `app.ai` and `app.secrets`.

## Decision

`@epicenter/app/clipboard` exports one `clipboard` value with `readText()` and
`writeText(text)`, selected for the build by a `#platform/clipboard` seam. The
browser leaf uses `navigator.clipboard`; the `epicenter-host` leaf uses the
Tauri clipboard plugin, whose read-text and write-text permissions the generic
trusted app-window capabilities grant. Both leaves share one normalization:
empty text reads as `null`, and a thrown platform failure becomes a
`ClipboardRead` or `ClipboardWrite` error carrying the cause.

The clipboard is not an App capability. Every capability on an opened App earns
its place by capturing scope or owning a resource: secrets capture app and
account, recording captures the library destination, blobs capture the replica,
AI owns transport identity and pending requests. A clipboard captures none of
these and has no cleanup owner. The only thing an App handle could add is its
lifetime guard, and that guard is wrong for a clipboard. A boot-failure screen
that offers to copy diagnostics runs before `app.ready`; none does today, and
the guard would forbid building one. A copy button clicked during deliberate
departure lands after `close()`. Both must work.

Cursor delivery, pasteboard preservation, simulated Enter, and simulated copy
stay in Whispering's text service. They need accessibility grants, foreground
focus, and product policy about where text lands. The host's `write_text`
command is delivery, not a clipboard write, and is never exposed as one.

## Consequences

- Whispering's text service keeps `writeToCursor`, `simulateEnterKeystroke`,
  and `simulateCopyKeystroke`, and no longer has clipboard methods or clipboard
  error variants. Its call sites import `clipboard` directly. Selection capture
  returns `TextError | ClipboardError`.
- The clipboard plugin is a dependency of `@epicenter/app`, not of Whispering.
- Presentation code and boot screens can copy without an App handle.
  `packages/ui` keeps its `navigator.clipboard` default and injectable copy
  function; the shared module is available when a host build needs it.
- No lifecycle tests exist for the clipboard, because it has no lifecycle.

## Considered alternatives

- **`app.clipboard` supplied through `ApplicationRuntime`.** Rejected: it adds
  a runtime field for something that is not an opened resource, and its
  lifetime guard rejects exactly the pre-ready and post-close copies a person
  expects to work. Presentation code would need an App handle to copy.
- **A narrow host command for read and write.** Rejected: the plugin is already
  registered in the host and exposes exactly the two operations, so a command
  would duplicate it and require Rust, bindings, and permission wiring.
- **A separate `@epicenter/clipboard` package.** Not chosen now: two functions do
  not justify a package, and `@epicenter/app` already owns the `epicenter-host`
  typecheck leaf, the `#platform/*` seams, and the Tauri API dependency. Move it
  if a package that must not depend on `@epicenter/app` needs it.
