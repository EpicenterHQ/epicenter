<!--
	The end of sign-in: finish it, then load the page it started from, so the
	app always starts with one account for the page's whole life.
-->
<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/account';
	import { resolve } from '$app/paths';
	import { Loading } from '@epicenter/ui/loading';
	import { account } from '$lib/app.js';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		// Only a browser's sign-in ends here; a Tauri window's ends in the shell.
		if (!isCallbackAuthClient(account)) return;
		void account
			.completeSignIn()
			.then(({ data, error }) => {
				if (error !== null) errorMessage = error.message;
				else window.location.replace(data.returnTo ?? resolve('/'));
			});
	});
</script>

{#if errorMessage}
	<div class="flex h-dvh flex-col items-center justify-center gap-2 px-6 text-center text-sm">
		<p class="text-destructive">Sign-in failed: {errorMessage}</p>
		<a class="underline" href={resolve('/')}>Back to Todos</a>
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
