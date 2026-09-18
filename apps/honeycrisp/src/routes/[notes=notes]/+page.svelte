<script lang="ts">
	import { openApp } from '@epicenter/app/open';
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { createDeparture } from '@epicenter/app-shell/departure';
	import { resolve } from '$app/paths';
	import { honeycrispDefinition } from '$lib/data.js';
	import { authStartup } from '#platform/auth';
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '@epicenter/ui/button';
	import Notes from '../components/Notes.svelte';
	import NotesLinks from '../components/NotesLinks.svelte';

	const account = authStartup.auth?.state.account;
	const opening = openApp(honeycrispDefinition, { account });
	const departure = createDeparture({
		opening,
		auth: authStartup.auth ?? undefined,
		account,
	});
	departure.attachUi({
		async quiesce() {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			// AppBoot's closing phase removes the editor before storage closes.
			await tick();
		},
	});
</script>

<AppBoot
	startup={authStartup}
	{opening}
	{departure}
	connectionHref={resolve('/connect')}
	homeHref={resolve('/')}
	appName="Honeycrisp"
	noun="notes"
>
	{#snippet children(app)}
		{#if page.params.notes === 'local'}
			<Notes data={app.device} />
		{:else if app.account}
			<Notes data={app.account.personal} />
		{:else}
			<div class="flex h-dvh flex-col items-center justify-center gap-4">
				<NotesLinks />
				<p>Sign in to use Personal.</p>
				<Button
					onclick={() => void departure
						.go(() => location.assign(resolve('/connect')))
						.catch(() => {})}
				>Sign in</Button>
			</div>
		{/if}
	{/snippet}
</AppBoot>
