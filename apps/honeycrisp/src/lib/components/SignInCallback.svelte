<!--
	The end of sign-in: finish it, then load the page it started from, so the
	app always starts with one account for the page's whole life.
-->
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { webAuth } from '../auth.js';
	import type { CallbackProps } from '../platform.js';

	let { home }: CallbackProps = $props();
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void webAuth()
			.completeSignIn()
			.then(({ data, error }) => {
				if (error !== null) errorMessage = error.message;
				else window.location.replace(data.returnTo ?? home);
			});
	});
</script>

{#if errorMessage}
	<div class="flex h-dvh flex-col items-center justify-center gap-2 px-6 text-center text-sm">
		<p class="text-destructive">Sign-in failed: {errorMessage}</p>
		<a class="underline" href={home}>Back to Honeycrisp</a>
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
