<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { resolve } from '$app/paths';
	import { auth } from '#platform/auth';

	// The one thing this route does, and it opens nothing: no store, no Web
	// Lock, no IndexedDB (ADR-0345). It renders under the root layout alone,
	// beside the `(app)` group rather than inside it.
	//
	// `completeSignIn`, not `startSignIn`. Starting used to mean finishing here,
	// because the browser launcher inspected the URL for a `code` first; asking
	// to begin a sign-in in order to end one is now a redirect loop rather than
	// a subtlety, since starting always starts.
	//
	// `authClient` rather than `auth`: this calls a verb and renders nothing off
	// auth state, so there is nothing to track.
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
						if (!auth || !isCallbackAuthClient(auth)) {
				// The desktop build. Its sign-in goes through the host, which
				// relaunches the process with the new identity, so no browser
				// callback ever lands here and this sentence is unreachable in
				// practice. It exists because one route file is compiled into every
				// build and pretending otherwise would be a cast.
				errorMessage = 'This build does not sign in through a browser callback.';
				return;
			}
			const { error } = await auth.completeSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			// A document replacement rather than `goto`, and it is unconditional
			// because it is the only thing that leaves the callback URL. Nothing
			// above this route navigates for it: the reload gate that used to is
			// deleted (ADR-0350), and the boot node at `/` reads auth reactively,
			// which is a thing this document cannot become by staying alive.
			// `resolve`, not a literal '/': the Epicenter build serves this app
			// under a base path, so the root of THIS app is not the origin's.
			window.location.replace(resolve('/'));
		})();
	});
</script>

{#if errorMessage}
	<div
		class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive"
	>
		{errorMessage}
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
