<script lang="ts">
	import { resolve } from '$app/paths';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '$lib/auth.svelte.js';

	// Completion only, and it opens nothing: the repository is opened by the
	// `(app)` layout, a sibling of this route under the chrome-only root
	// layout (ADR-0345).
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const { data, error } = await auth.completeSignIn();
			if (error !== null) {
				errorMessage = error.message;
				return;
			}
			// A document replacement rather than `goto`, and it is unconditional
			// because it is the only thing that leaves the callback URL. Nothing
			// above this route navigates for it: the reload gate that used to is
			// deleted (ADR-0350), and the signed-in layout at `/` reads auth
			// reactively, which is a thing this document cannot become by staying
			// alive. It returns to the page the sign-in or renewal started from,
			// `/` when none was named.
			window.location.replace(data.returnTo ?? resolve('/'));
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
