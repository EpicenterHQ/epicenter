<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { resolve } from '$app/paths';
	import { honeycrispDefinition } from '$lib/data.js';
	import { page } from '$app/state';
	import { Button } from '@epicenter/ui/button';
	import Notes from '../components/Notes.svelte';
	import NotesLinks from '../components/NotesLinks.svelte';
</script>

<AppBoot
	{auth}
	definition={honeycrispDefinition}
	connectionHref={resolve('/connect')}
	homeHref={resolve('/')}
	appName="Honeycrisp"
	noun="notes"
>
	{#snippet children(app, leave)}
		{#if page.params.collection === 'local'}
			<Notes data={app.device} />
		{:else if app.account}
			<Notes data={app.account.personal} />
		{:else}
			<div class="flex h-dvh flex-col items-center justify-center gap-4">
				<NotesLinks />
				<p>Sign in to use Personal.</p>
				<Button
					onclick={() => void leave(() => location.assign(resolve('/connect')))
						.catch(() => {})}
				>Sign in</Button>
			</div>
		{/if}
	{/snippet}
</AppBoot>
