<!--
	The end of sign-in: the web app finishes it, then loads the page it
	started from, so the app always starts with one account for the page's
	whole life. The desktop window signs in through the system browser and
	never comes here; if something does send it here, it says so.
-->
<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/account';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { resolve } from '$app/paths';
	import { account } from '$lib/app.js';

	const home = resolve('/');
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		if (!isCallbackAuthClient(account)) return;
		// A document replacement rather than `goto`, and it is unconditional
		// because it is the only thing that leaves the callback URL. It returns
		// to the page the sign-in or renewal started from, `home` when none was
		// named, which opens a new folder over the new account.
		void account.completeSignIn().then(({ data, error }) => {
			if (error !== null) errorMessage = error.message;
			else window.location.replace(data.returnTo ?? home);
		});
	});
</script>

{#if !isCallbackAuthClient(account)}
	<Empty.Root class="h-dvh">
		<Empty.Title>Vocab does not sign in here</Empty.Title>
		<Empty.Description>Vocab on this computer signs in through your browser, from its account menu.</Empty.Description>
		<a class="text-sm underline" href={home}>Back to Vocab</a>
	</Empty.Root>
{:else if errorMessage}
	<div class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive">
		{errorMessage}
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
