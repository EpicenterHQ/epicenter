# Thin Goal Template

A `/goal` that invokes this skill should be 5-10 lines. The skill carries the ritual; the goal carries only what varies per pass.

## Minimal template

```
/goal Run a collapse pass on <packages and apps in scope>.

  Load skill: collapse-pass.
  Scope: <list, narrowest-first>
  Stop condition: <three no-finding files | N checkpoints | queue empty>
  Citation: <mandatory deepwiki | optional>
  Starting target: <package name>

  Begin.
```

## Worked examples

### Audit-style pass with deepwiki grounding

```
/goal Run a collapse pass on packages/auth and packages/encryption.

  Load skill: collapse-pass.
  Scope: packages/auth, packages/auth-svelte, packages/encryption
  Stop condition: 8 checkpoints
  Citation: mandatory; cite arktypeio/arktype, better-auth/better-auth,
    signalapp/libsignal as relevant
  Starting target: packages/auth

  Begin.
```

### Signal-based pass

```
/goal Run a collapse pass on the store runtime.

  Load skill: collapse-pass.
  Scope: packages/app, packages/svelte
  Stop condition: three consecutive no-finding files
  Citation: optional
  Starting target: packages/app

  Begin.
```

### Exhaustive pass

```
/goal Run a collapse pass on the hosted API surface.

  Load skill: collapse-pass.
  Scope: packages/server, apps/api
  Stop condition: queue empty
  Citation: optional
  Starting target: packages/server

  Begin.
```

## What does NOT belong in the goal

The skill already owns:

- The per-iteration ritual (pick, inline, one-sentence, surface, apply, commit, sweep)
- The finding format
- The anti-cosmetic gate
- The smell catalog with grep patterns
- The durable-strings never-touch list (in `references/never-touch.md`)
- The pause list
- The library-refusal operating principle
- The per-checkpoint surface format
- The final report shape

If a goal repeats any of those, the skill has drifted. Update the skill, not the goal.
