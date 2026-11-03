<!--
	The end of sign-in: finish it, then load the page it started from, so the
	app always starts with one account for the page's whole life. This page
	makes its own sign-in and never opens the world (`$lib/app`).
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Loading } from '@epicenter/ui/loading';
	import { createWebAuth } from '$lib/auth.js';

	const auth = createWebAuth();
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void auth.completeSignIn().then(({ data, error }) => {
			if (error !== null) errorMessage = error.message;
			else window.location.replace(data.returnTo ?? resolve('/'));
		});
	});
</script>

{#if errorMessage}
	<div class="flex h-dvh flex-col items-center justify-center gap-2 px-6 text-center text-sm">
		<p class="text-destructive">Sign-in failed: {errorMessage}</p>
		<!-- A full load: the app's world opens once per page. -->
		<a class="underline" href={resolve('/')} data-sveltekit-reload>Back to Todos</a>
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
