# @epicenter/app

What an Epicenter app is: a **manifest** and a **module whose `mount` shows
the app over one open repository**. This package holds the contract's types
and the checks that go with them. It depends on no framework, so an app
built with Svelte, React or plain DOM implements the same `mount`. The model
is [ADR-0694](../../docs/adr/0694-installing-an-app-is-trusting-it.md); the
addresses are [ADR-0693](../../docs/adr/0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md).

## The manifest

```ts
import { defineManifest } from '@epicenter/app';
import { defineApp } from '@epicenter/repository';

export const manifest = defineManifest({
	name: 'Todos',
	hostname: 'todos.epicenter.so',
	collections: defineApp({ todos: { path: 'todos/{stem}.md', schema } }),
});
```

- `hostname` identifies the app: the HTTPS hostname it is served at the root
  of. It must be two or more lowercase DNS labels (`isHostname`). No owner or
  repository name has a dot, so an address's third segment is always an app.
- `collections` are the typed views the app reads. The shell opens each
  repository with every installed app's collections together, so the
  repository an app is given may hold other apps' collections too.
- `defineManifest` throws on a bad hostname or an empty name. Like
  `defineApp`, that is a mistake in the app's source, found when it loads.

## Mount

```ts
import type { Mount } from '@epicenter/app';

export const mount: Mount<typeof manifest> = (element, { repo, path, navigate }) => {
	// show the app in `element`
	return {
		unmount() {},
		setPath(next) {}, // optional: follow a URL that changed under the app
	};
};
```

| Given | What it is |
| --- | --- |
| `repo` | The open repository, as the app's collections read it, with the plain file API (`repo.files`). |
| `path` | Everything after the app's hostname segment, with the query, from `/` (`isAppPath`). Segments stay as the URL encodes them. |
| `navigate(path, { replace? })` | Asks the shell to move the app: a new history entry, or `replace`. It resolves once the URL shows the new path. |

The shell owns the URL and history. The app owns its path. When the URL
changes under the app (Back, Forward, a link), the shell calls `setPath`;
an app without `setPath` is mounted again. `unmount` comes before the
repository closes, so the app's editors close first.

An app whose routes are file paths reads them with `fileOfPath(path)` and
writes them with `pathOfFile(file)`; Files and Honeycrisp do. For a Svelte
root, `mountSvelte(Root)` from `@epicenter/svelte/app` is the whole `mount`.

## Checks

From `packages/app`: `bun run typecheck` and `bun run test` (the hostname
rule, `defineManifest`, and app paths).
