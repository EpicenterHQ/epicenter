<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '$lib/auth';

	// Completion only, and it opens nothing: the store is opened by
	// `+page.svelte`, which is a sibling under the same chrome-only root layout
	// (ADR-0345).
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			if (!isCallbackAuthClient(auth)) {
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
			window.location.replace('/');
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
