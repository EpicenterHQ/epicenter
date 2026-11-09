# Anti-slop rules

Source: https://github.com/dmmulroy/anti-slop

Revision: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-14).

The four files in `rules/` and their five dependencies in `shared/` are copied
unchanged from `src/` at that revision. `LICENSE` preserves the upstream MIT
license. `index.ts` registers only Epicenter's selected rules.

`.oxlintrc.json` enables chained assertions, known-value widening, and
widen-then-assert as errors. Assertion justifications are warnings. Biome owns
formatting and the existing lint rules. Oxlint's built-in rules are disabled.

The plugin uses syntax and lexical scope, without TypeScript type checking or
cross-file inference. It checks JavaScript and TypeScript files; it does not
check script blocks inside Svelte or Astro components.

Update the selected files and their dependency closure from a named upstream
revision, preserve the license, and run `bun run lint:anti-slop` and the lint
integration tests before changing this record.
