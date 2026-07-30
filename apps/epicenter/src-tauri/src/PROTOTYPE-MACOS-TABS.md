# Prototype: macOS native tabs over Epicenter's existing windows

Throwaway. Answered, and the answer is no. Delete this file with
`prototype_macos_tabs.rs`, its call sites in `lib.rs`, and the three
`objc2-app-kit` features added for it.

## The question

Can `WebviewWindowBuilder::tabbing_identifier` make Home, Whispering, and
admitted-app windows appear as native macOS tabs while each keeps its own
window label, capability file, recorder ownership, and the ability to be pulled
out and used side by side?

## The answer

**No, not on the stable Tauri surface, and not cleanly with AppKit either.**

The stable surface does nothing at all on a default Mac. Explicit AppKit calls
do produce real tabs, and most of the mechanics survive, but the two behaviors
the product actually promises (detach for side-by-side, and reveal an app
without disturbing what the user arranged) become the same call and fight each
other. Getting out of that fight needs per-window "the user detached this"
state, which is the preference this experiment was told not to add.

## What was measured

macOS 26.5.2, Apple M4 Max, Tauri 2.11.5 / tao 0.35.3, `Epicenter Dev` debug
build, real GUI, real clicks in Home. `EPICENTER_PROTOTYPE_TABS` selects the
variant.

### `auto`: shared `tabbing_identifier` only

```
created whispering (reveal=false): preference=in-full-screen allowsAutomaticTabbing=true whispering(visible=false,tabbed=no-tab-bar)
created home (reveal=true):        preference=in-full-screen allowsAutomaticTabbing=true home(visible=true,tabbed=no-tab-bar) whispering(visible=false,tabbed=no-tab-bar)
revealed existing whispering:      preference=in-full-screen allowsAutomaticTabbing=true home(visible=true,tabbed=no-tab-bar) whispering(visible=true,tabbed=no-tab-bar)
```

Clicking Whispering in Home opened a second ordinary window stacked on the
first. No tab bar, ever.

Two facts explain it, and only one of them is fixable:

1. `allowsAutomaticWindowTabbing` is an **application-wide class property**, and
   `tauri-runtime-wry` sets it to `false` the first time any window is built
   without a tabbing identifier, or transparent, or undecorated. The recording
   overlay is transparent and undecorated and is created before every surface,
   so the application has already opted out before Home exists. This prototype
   undoes it (`allowsAutomaticTabbing=true` above), so it is not the blocker.
2. `tabbingMode` defaults to automatic, which means AppKit consults
   `NSWindow.userTabbingPreference`, a **System Settings choice**. This machine
   reports `in-full-screen`, the macOS default (Desktop & Dock, "Prefer tabs
   when opening documents"). Outside full screen, automatic tabbing simply does
   not happen.

So the stable API's behavior is owned by a setting we do not control and most
users never change. Shipping on it would mean the feature exists for a minority
of Macs and is invisible on the rest, with no way to explain the difference.

### `force`: shared identifier plus `addTabbedWindow:ordered:`

Real tabs, immediately:

```
revealed existing whispering: home(visible=true,tabbed=2) whispering(visible=true,tabbed=2)
created app-dictation:        app-dictation(visible=true,tabbed=3) home(visible=true,tabbed=3) whispering(visible=true,tabbed=3)
```

What worked:

- Home, Whispering, and an admitted app (`app-dictation`) grouped into one
  window with a native tab bar titled from each window's own title.
- Switching tabs both ways preserved each surface's state.
- Clicking Whispering in Home again selected the existing tab. No duplicate.
- Window > Move Tab to New Window detached Whispering into its own window; it
  could then be moved anywhere and used beside the group.
- ⌘W on the Whispering tab hit the existing `CloseRequested` interception: the
  window was hidden, not destroyed (`whispering(visible=false,tabbed=no-tab-bar)`),
  and the surviving tabs stayed grouped. Nothing closed the wrong application.
- Window labels never changed, so capability files and recorder ownership are
  untouched by construction. 121 Rust tests, including the capability and label
  tests, still pass.

What broke:

1. **Reveal steals the user's arrangement.** After detaching Whispering and
   moving it to the corner of the screen, clicking Whispering in Home dragged it
   back into the tab group and back to the group's position. Adoption has to
   happen on reveal (Whispering is pre-created hidden at startup, so its first
   appearance is always a reveal of an existing window, never a creation), and
   reveal is exactly the same event as "the user asked for this app again after
   arranging it themselves". Telling the two apart requires remembering, per
   window, that the user detached it.
2. **A closed tab does not come back as a tab.** Hiding removes the window from
   the group. The next reveal re-adopts it, which is defensible, but combined
   with (1) it means the group's membership is whatever the last reveal did, not
   anything the user chose.
3. **The tab bar highlight desynchronizes.** `focus()` is `show()` +
   `set_focus()`, which makes a window key without going through
   `tabGroup.selectedWindow`. Revealing Home showed Home's content under a tab
   bar that still highlighted the admitted app's tab. Fixing that is another
   AppKit call on the focus path.
4. **Shared chrome follows the active tab's appearance.** The dark Home and
   Whispering surfaces and a light admitted app share one tab bar, so the chrome
   flips light and dark as tabs are selected.
5. **Every window title starts with `Epicenter: `**, which is fine on a title
   bar and redundant repeated across a tab bar.

## On admitted apps specifically

They group fine and need no separate treatment for grouping. The lifecycle
mismatch is worth stating anyway: a compiled surface is hidden on close and an
admitted-app window is destroyed on close, so two tabs in one bar answer ⌘W
differently. The user sees the same disappearance and gets different state back.
That is a pre-existing asymmetry native tabs make visible rather than one they
create, and it is not a reason to hold admitted apps out of the group.

## Windows

There is no equivalent. `tabbing_identifier` is macOS-only in Tauri, and Windows
has no OS-level window tabbing to target. Nothing here is a Windows
implementation, and the mission did not ask for one. Windows stays ordinary
multi-window.

## Recommendation

Do not ship either variant. `auto` does nothing on a default Mac; `force` buys
tabs by taking over window placement on a path the user invokes for an unrelated
reason, and needs three more AppKit interventions (selection, adoption
suppression, re-adoption policy) before it stops surprising people. If one
visual window is still wanted later, the honest version is a real in-app tab
strip the shell owns, not AppKit's.
