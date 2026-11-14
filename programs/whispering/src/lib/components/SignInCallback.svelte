<!--
	The page that ends a sign-in: in a browser it finishes the sign-in this
	tab started and loads the page it started from, or `home`. A Tauri window
	signs in through the system browser and its shell hears the answer, so it
	never comes here; if something does send it here, it says so. It reads no
	files.
-->
<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/account';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount } from 'svelte';
	import { account } from '../app.js';

	let { home }: { home: string } = $props();

	let errorMessage = $state<string>();

	onMount(() => {
		if (!isCallbackAuthClient(account)) return;
		void account.completeSignIn().then(({ data, error }) => {
			if (error !== null) {
				errorMessage = error.message;
				return;
			}
			window.location.replace(data.returnTo ?? home);
		});
	});
</script>

{#if !isCallbackAuthClient(account)}
	<Empty.Root class="h-dvh">
		<Empty.Title>Whispering does not sign in here</Empty.Title>
		<Empty.Description>Whispering on this computer signs in through your browser, from Settings.</Empty.Description>
		<a class="text-sm underline" href={home}>Back to Whispering</a>
	</Empty.Root>
{:else if errorMessage}
	<p class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive" role="alert">{errorMessage}</p>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
