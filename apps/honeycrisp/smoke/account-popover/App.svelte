<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { createHostedBrowserRedirectAuth } from '@epicenter/auth';
	import { fromAuth } from '@epicenter/auth/svelte';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { onDestroy, untrack } from 'svelte';

	let { baseURL, session }: { baseURL: string; session: { token: string; principalId: string } } = $props();
	const appId = 'so.epicenter.honeycrisp';
	const params = new URLSearchParams(window.location.search);
	untrack(() => {
		if (params.has('signedOut')) localStorage.removeItem(`${appId}.auth.persisted`);
		else localStorage.setItem(`${appId}.auth.persisted`, JSON.stringify(session));
	});
	const client = createHostedBrowserRedirectAuth({ appId, baseURL: untrack(() => baseURL) });
	const auth = fromAuth(client);
	onDestroy(() => client[Symbol.dispose]());
</script>

<Tooltip.Provider>
	<main class="mx-auto max-w-xl space-y-6 p-8">
		<header class="flex items-center justify-between">
			<h1 class="text-xl font-semibold">Shared account menu smoke</h1>
			<AccountPopover {auth} syncNoun="notes" disabledReason={params.has('locked') ? 'Stop recording to change your account' : undefined} />
		</header>
		<p>This disposable page mounts the same account menu used by Honeycrisp, Vocab, and Whispering.</p>
		<label class="grid gap-2">Work in progress<textarea class="min-h-40 rounded border p-3" aria-label="Work in progress"></textarea></label>
	</main>
</Tooltip.Provider>
