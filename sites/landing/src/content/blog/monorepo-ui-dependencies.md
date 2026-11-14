---
title: 'The Monorepo UI Package Dependency Trap'
description: 'Why your apps are installing the same dependencies as your UI package, and how to fix it'
pubDate: 'Jan 30 2025'
heroImage: '/blog-placeholder-3.jpg'
---

I was working on my monorepo and noticed something odd. My Epicenter app needed to install `bits-ui` and `@lucide/svelte` even though I was already importing these through my shared UI package.

Wait, shouldn't the UI package provide these dependencies?

Here's what I found: the UI package had these dependencies in `devDependencies` instead of `dependencies`. That's the trap.

## The Problem

When you structure a UI package like this:

```json
{
  "name": "@epicenter/ui",
  "devDependencies": {
    "bits-ui": "catalog:",
    "@lucide/svelte": "^0.525.0",
    "clsx": "catalog:",
    "tailwind-merge": "catalog:"
  }
}
```

Those packages are only installed when developing the UI package itself. Apps that consume `@epicenter/ui` don't get them.

So every app ends up looking like this:

```json
{
  "name": "my-app",
  "dependencies": {
    "@epicenter/ui": "workspace:*",
    "bits-ui": "catalog:",      // Duplicate!
    "@lucide/svelte": "^0.525.0" // Duplicate!
  }
}
```

## The Fix

Move runtime dependencies to `dependencies` in your UI package:

```json
{
  "name": "@epicenter/ui",
  "dependencies": {
    "bits-ui": "catalog:",
    "@lucide/svelte": "^0.525.0",
    "clsx": "catalog:",
    "tailwind-merge": "catalog:"
  },
  "devDependencies": {
    // Only build tools and types here
    "typescript": "^5.7.3",
    "svelte-check": "catalog:"
  }
}
```

Now your apps can be cleaner:

```json
{
  "name": "my-app",
  "dependencies": {
    "@epicenter/ui": "workspace:*"
    // That's it! UI deps come along automatically
  }
}
```

## The Lesson

In monorepo UI packages, ask yourself: "Does the consuming app need this at runtime?"

If yes → `dependencies`  
If no → `devDependencies`

Common runtime dependencies for UI packages:
- Component libraries (bits-ui, radix-ui)
- Icon libraries (@lucide/svelte)
- Runtime utilities (clsx, tailwind-merge)
- Styling tools used at runtime (tailwind-variants)

Common dev dependencies:
- Type definitions (@types/*)
- Build tools (vite, rollup)
- Linters and formatters
- Testing libraries

I had 3 apps all installing the same UI dependencies. Now they just install `@epicenter/ui` and get everything they need. Less duplication, clearer dependency tree, easier maintenance.

The fix took 2 minutes. Finding the problem took me way longer than I'd like to admit.