<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { authStartup } from '#platform/auth';
	import { resolve } from '$app/paths';

	// Completion only. This route renders under the root layout, which is chrome
	// (ADR-0345), so nothing above it opens a store; the notes are opened by
	// `+page.svelte`, which is a sibling.
	//
	// `completeSignIn`, not `startSignIn`: starting always starts now, so asking
	// it to finish a callback would mint a fresh PKCE transaction and redirect
	// straight back here.
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const auth = authStartup.auth;
			if (!auth || !isCallbackAuthClient(auth)) {
				// The desktop build signs in through the host, which relaunches the
				// process, so no browser callback lands here.
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
