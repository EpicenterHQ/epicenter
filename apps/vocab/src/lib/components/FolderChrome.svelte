<!--
	When the folder is on this computer (`folder.reveal`): the header's account
	of its store, Vocab's folder on this computer, whether Epicenter syncs it,
	and where to get Epicenter until it does. A desktop app never syncs
	(ADR-0822). Its account only adds hosted tutor models and dictation.
-->
<script lang="ts">
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { account, folder } from '../app.js';
	import AccountMenu from './AccountMenu.svelte';

	// `<WhenOpen>` renders the pages, and so this, only over the open folder.
	const sync = folderSync({ path: folder.displayPath() ?? '' });

	const status = $derived.by((): StatusLine => {
		const unavailable = folder.unavailable();
		if (unavailable !== null) return { label: 'Not readable here', detail: unavailable.message, tone: 'error' };
		if (sync.synced) return { label: 'Synced by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});

	async function signInAgain() {
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<div class="min-w-0 max-md:mr-auto">
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">This computer</span>
			<FolderOnboarding noun="entries" path={sync.path} pathTestId="status-folder" />
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if sync.synced}
					Epicenter keeps it in sync across your devices.
				{:else}
					Your words and chats are Markdown files here. Epicenter syncs them across your devices.
				{/if}
			</span>
		</StatusRow>
	</StatusPopover>
</div>
<div class="flex min-w-0 items-center gap-1 md:order-last md:ml-auto">
	<FolderSyncActions {sync} />
	{#if account.state().status === 'reauth-required'}<Button size="sm" onclick={() => void signInAgain()}>Sign in again</Button>{/if}
	<LightSwitch variant="ghost" /><AccountMenu />
</div>
