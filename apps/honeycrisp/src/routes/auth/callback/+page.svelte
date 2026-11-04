<!--
	The end of sign-in: finish it, then load the page it started from, so the
	app always starts with one account for the page's whole life. The desktop
	window has no account and never signs in; if something sends it here, it
	says so.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { account } from '$lib/app.js';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void account
			?.completeSignIn()
			.then(({ data, error }) => {
				if (error !== null) errorMessage = error.message;
				else window.location.replace(data.returnTo ?? resolve('/'));
			});
	});
</script>

{#if account === null}
	<Empty.Root class="h-dvh">
		<Empty.Title>Honeycrisp does not sign in here</Empty.Title>
		<Empty.Description>Honeycrisp on this computer keeps its notes in a folder; Epicenter syncs it.</Empty.Description>
		<a class="text-sm underline" href={resolve('/')}>Back to Honeycrisp</a>
	</Empty.Root>
{:else if errorMessage}
	<div class="flex h-dvh flex-col items-center justify-center gap-2 px-6 text-center text-sm">
		<p class="text-destructive">Sign-in failed: {errorMessage}</p>
		<a class="underline" href={resolve('/')}>Back to Honeycrisp</a>
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
