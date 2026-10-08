# 0245. An app declares its theme in its html tag, and the pre-paint script only undoes it

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

Every Epicenter app is a client-rendered SPA: `export const ssr = false` with
`adapter-static` and a `fallback`. `mode-watcher` ships its own
flash-prevention script (`setInitialMode`) and injects it through
`svelte:head`, which never reaches the served HTML, because nothing from a
component renders server-side. Its copy runs after the bundle hydrates, which
is after first paint, so the library's own answer cannot work here.

Six apps compensated with a byte-identical inline script in `app.html` that
read storage, defaulted to `'dark'`, applied the class, and then wrote the
value back. Two apps, vocab and skills, had no script at all and quietly
followed the system theme while nothing in their layouts looked any different.
The write-back was the subtler defect: it persisted a value on the first visit,
so by the time `ModeWatcher` mounted, storage always had one and
`defaultMode="dark"` was never consulted. Every layout carried a prop that
reads as the theme decision and controlled nothing, and because it displayed
the correct value, it invited trust.

## Decision

The `<html>` tag declares the theme, and the pre-paint script only handles
deviation from it.

```html
<html lang="en" class="dark" style="color-scheme: dark">
  <head>
    <script>
      if (localStorage.getItem('mode-watcher-mode') === 'light') {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      }
    </script>
```

```svelte
<ModeWatcher defaultMode="dark" track={false} />
<LightSwitch />
```

The script states no default and writes no storage, so storage holds a choice
rather than a first visit and `defaultMode` is live again. Only `light` is
tested, because `toggleMode` writes exactly `light` or `dark` and no surface
calls `resetMode`: `system` is never stored. Every app ships a way to change
the mode, because a declared default is only honest if it can be left.

This is written by hand in every app. There is no shared theme package, no Vite
plugin, and no placeholder filled at build or render time.

## Consequences

- A default cannot disagree with itself. It is one word, in one tag, in a file
  each app already owns and opens.
- The word `dark` still appears twice per app: once in the `<html>` tag for
  before paint, once as `defaultMode` for after hydration. That duplication is
  irreducible without writing storage on first paint, and we chose legibility
  over removing it.
- The script is four lines because `system` is refused. Offering a system
  option means restoring the `matchMedia` branch and revisiting this ADR.
- Nothing prevents a new app from omitting the script. The symptom is a flash
  of the wrong theme on load, and there is no build-time guard. That is the
  accepted cost of keeping the mechanism visible at each call site.
- `LightSwitch` in `@epicenter/ui/light-switch` is the shared toggle. `api/ui`
  and `whispering` reach light mode through their own menus instead, which
  satisfies the requirement without adopting the component.

## Considered alternatives

- **A package plus a Vite plugin injecting the snippet.** Removes the copies,
  but `app.html` then looks untouched, and "nothing visible is missing" is
  exactly how vocab and skills lost their script.
- **A `%theme%` placeholder filled by `transformPageChunk`.** Documented
  SvelteKit, and it does run when `adapter-static` generates the fallback. It
  buys one literal in exchange for a hook file per app and a call site that no
  longer names what happens there.
- **`%sveltekit.env.PUBLIC_DEFAULT_MODE%` feeding both places.** Makes the two
  statements provably agree, at the cost of a `.env` entry per app to say one
  word, and moves a design decision into configuration.
- **Deleting the machinery in apps with no toggle.** Five apps could not reach
  light mode at all, so the apparatus served a control that did not exist.
  Rejected because the intended destination is that every app can change its
  theme, not that most cannot.
- **Relying on `ModeWatcher` alone, as shadcn-svelte documents.** Impossible
  under `ssr = false`; that guidance assumes server rendering.
