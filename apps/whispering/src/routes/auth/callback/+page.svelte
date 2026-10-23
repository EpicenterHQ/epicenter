<script lang="ts">
	import { resolve } from '$app/paths';
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount } from 'svelte';
	import { getAuth } from '#platform/auth';

	let errorMessage = $state<string>();

	onMount(() => {
		const auth = getAuth();
		if (!isCallbackAuthClient(auth)) {
			errorMessage = 'This sign-in callback is available in the browser app.';
			return;
		}
		void auth.completeSignIn().then(({ data, error }) => {
			if (error !== null) {
				errorMessage = error.message;
				return;
			}
			window.location.replace(data.returnTo ?? resolve('/'));
		});
	});
</script>

{#if errorMessage}
	<p class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive" role="alert">{errorMessage}</p>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
