<!--
	The desktop window's header account of its store: Vocab's folder on this
	computer, whether Epicenter manages it, and Set up in Epicenter beside
	the account, which
	only adds hosted tutor models and dictation. Vocab never syncs anything
	itself.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import { getFolderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import type { ChromeProps } from '../platform.js';
	import AccountMenu from './AccountMenu.svelte';

	let { unreadable }: ChromeProps = $props();

	// DesktopRoot renders the app, and so this, only over its open data folder.
	const sync = getFolderSync();

	const status = $derived.by((): StatusLine => {
		if (unreadable !== null) return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
		if (sync.managed) return { label: 'Kept by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});

	async function signInAgain() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<div class="min-w-0 max-md:mr-auto">
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">This computer</span>
			<FolderOnboarding noun="entries" path={sync.path} pathTestId="status-folder" />
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if sync.managed}
					Epicenter keeps its local history. Connect a repository there to use it on other devices.
				{:else}
					Your words and chats are Markdown files here. Set up Epicenter to keep their history, then connect a repository to use them elsewhere.
				{/if}
			</span>
		</StatusRow>
	</StatusPopover>
</div>
<div class="flex min-w-0 items-center gap-1 md:order-last md:ml-auto">
	<FolderSyncActions {sync} />
	{#if auth.state().status === 'reauth-required'}<Button size="sm" onclick={() => void signInAgain()}>Sign in again</Button>{/if}
	<LightSwitch variant="ghost" /><AccountMenu />
</div>
