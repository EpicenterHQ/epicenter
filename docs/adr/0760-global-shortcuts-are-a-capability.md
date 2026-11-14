# 0760. Global shortcuts are a capability

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) at its capability list and at "Whispering's global shortcut is an app-owned native feature": `shortcut` is a capability, and no `#platform/*` seam remains for it; [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) at "Whispering's global shortcut is one" of the features no capability covers: a capability covers it.
- **Relates:** [ADR-0117](0117-global-shortcut-input-is-plugin-chords-only-and-the-macos-tap-is-just-the-paste-grant-watcher.md) (global shortcut input is `tauri-plugin-global-shortcut` chords only), [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (what a capability is), [ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md) (app-specific native code in `modules/<name>/`).
- **Unbuilt:** `@epicenter/shortcut`, its TypeScript surface, and its plugin declaration; removing `apps/whispering/src-tauri/src/shortcut.rs` and the Epicenter app's direct registration of `tauri-plugin-global-shortcut`.

## Context

Two desktop apps hold a global shortcut, each through its own Rust.
Whispering's `apps/whispering/src-tauri/src/shortcut.rs` (77 lines) wraps
`tauri-plugin-global-shortcut`: `set_shortcut` holds one accelerator such as
`CommandOrControl+Shift+;`, and each press emits
`whispering://toggle-recording` to the page. The Epicenter app registers the
same plugin in `948ea39cf4:apps/epicenter/src-tauri/src/lib.rs` behind its `dictation`
feature.

[ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)
named Whispering's shortcut as its example of an app-owned native feature,
the one reason a `#platform/*` seam outlives the capabilities, and
[ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md)
counted `shortcut.rs` as the only Whispering Rust no capability covers. A
feature two apps share is not app-owned.

## Decision

**`@epicenter/shortcut` is a capability: TypeScript plus
`tauri-plugin-global-shortcut`, in one directory.** It holds global
shortcuts by accelerator and tells the page of each press. It is `null` on
the web, which has no global shortcuts
([ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)).

| App | Uses it for |
| --- | --- |
| Whispering | starting and stopping a recording from any app |
| the Epicenter app | its native dictation, in place of registering the plugin directly behind its `dictation` feature |

**Whispering has no app-specific native code.** Its shortcut is
`@epicenter/shortcut`; its `http.rs` relay for provider requests is the
endpoints' transport
([ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md),
[ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md)),
which ADR-0756 already counted as covered. Whispering has no `modules/`
([ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md)).

## Consequences

- An app gains a global shortcut by adding one dependency, and the generated
  shell registers the plugin and its permission.
- Whispering's `set_shortcut` command goes, and no `#platform/*` seam
  remains for the shortcut.
- One package owns the plugin's behavior when another app already holds a
  key, so Whispering and the Epicenter app report it the same way.
- The capability follows ADR-0117: chords the plugin can express. A gesture
  the plugin cannot bind, such as Fn alone, stays out of both apps.

## Considered alternatives

- **Each app keeps its own Rust (today).** Two wrappers of one plugin, and
  Whispering keeps a seam and native code for it.
- **Fold shortcuts into `@epicenter/recorder`.** The Epicenter app's
  shortcut is not a recording, and a recorder that registers keys does two
  jobs.
- **Import `@tauri-apps/plugin-global-shortcut` directly from each page.**
  Each app grants the plugin's permissions by hand and repeats the
  handling of a key another app holds.
