<!--
	The page that ends a sign-in in the web app: it finishes the sign-in this
	tab started and loads the page it started from, or `home`. It opens no
	files.
-->
<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount } from 'svelte';
	import { getAuth } from '../platform/auth.js';
	import type { CallbackProps } from '../platform/types.js';

	let { home }: CallbackProps = $props();

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
			window.location.replace(data.returnTo ?? home);
		});
	});
</script>

{#if errorMessage}
	<p class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive" role="alert">{errorMessage}</p>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
