<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Channel } from '@tauri-apps/api/core';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onMount } from 'svelte';
	import { type AuthGrant, commands, events, type HomeSection } from './bindings.gen';
	import { failureText } from './connections/connections';
	import { followHomeSections, keepInView } from './home-section';
	import { isDesktopHost } from './runtime.ts';
	import * as Empty from '@epicenter/ui/empty';
	import AiConnections from './connections/AiConnections.svelte';
	import LocalModelAdministration from './LocalModelAdministration.svelte';
	import { localModels } from './local-models.svelte';

	/**
	 * Host-level administration (ADR-0189) includes the app's sign-in, the AI
	 * connections every app may use (ADR-0557), and the local transcription
	 * model (ADR-0180), which lives here rather than in the shell
	 * header: choosing what every application on this device transcribes with is
	 * a settings act, not a conversation control.
	 *
	 * The sign-in is the `epicenter` CLI's desktop grant (ADR-0558): Sign in
	 * runs its loopback sign-in through the shell, which opens the browser, and
	 * no token reaches this page. A terminal's `epicenter auth login` is a
	 * separate sign-in this section neither shows nor ends.
	 *
	 * The choice names files and an accelerator on this machine, so a browser or
	 * remote Home says where it lives instead of offering controls that would
	 * reach the wrong device.
	 *
	 * An app that cannot transcribe locally sends the person here with
	 * `open_home('transcription')`, and the page scrolls to the model and keeps
	 * it there while the sections above it load.
	 */

	let origin = $state('');
	let grant = $state<AuthGrant | null>(null);
	let busy = $state<'reading' | 'signing-in' | 'signing-out' | null>('reading');
	let waitingForBrowser = $state(false);
	let accountError = $state('');

	async function readStatus() {
		const { data, error } = await commands.authStatus();
		if (error !== null) {
			accountError = failureText(error);
			return;
		}
		origin = data.origin;
		grant = data.grants.find((each) => each.grant === 'desktop') ?? null;
	}

	/** Where each section an app may ask for starts. */
	const sections = $state<Record<HomeSection, HTMLElement | undefined>>({
		account: undefined,
		transcription: undefined,
	});

	onMount(() => {
		if (!isDesktopHost()) return;
		void readStatus().finally(() => (busy = null));
		let stopScrolling: (() => void) | undefined;
		const stopFollowing = followHomeSections({
			claim: commands.takePendingHomeSection,
			// The window's own listener: the shell nudges this window alone.
			onNudge: (nudged) =>
				events.homeSectionPending(getCurrentWebviewWindow()).listen(nudged),
			show: (section) => {
				const target = sections[section];
				if (target === undefined) return;
				stopScrolling?.();
				// The account and the connections above it fill in after this.
				stopScrolling = keepInView(target);
			},
		});
		return () => {
			stopFollowing();
			stopScrolling?.();
		};
	});

	async function signIn() {
		busy = 'signing-in';
		accountError = '';
		const lines = new Channel<string>();
		lines.onmessage = (line) => {
			const value = JSON.parse(line) as { open?: string; error?: string };
			if (value.open) waitingForBrowser = true;
			if (value.error) accountError = value.error;
		};
		const { error } = await commands.authLogin(lines);
		if (error !== null) accountError = failureText(error);
		waitingForBrowser = false;
		await readStatus();
		busy = null;
	}

	async function signOut() {
		busy = 'signing-out';
		accountError = '';
		const { data, error } = await commands.authLogout();
		if (error !== null) accountError = failureText(error);
		else if (data.signedOut && !data.revoked)
			accountError = `${new URL(origin).host} could not be reached, so this computer's sign-in was removed but not revoked there.`;
		await readStatus();
		busy = null;
	}

	const signedInAs = $derived(
		grant?.signedIn
			? (grant.account?.name ?? grant.account?.id ?? 'your account')
			: null,
	);
</script>

{#if isDesktopHost()}
	<div class="grid gap-3 border-b p-3" bind:this={sections.account}>
		<h2 class="font-medium">Account</h2>
		{#if busy === 'reading'}
			<p class="text-muted-foreground">Reading this computer's sign-in…</p>
		{:else if signedInAs}
			<p>Signed in to {new URL(origin).host} as {signedInAs}.</p>
		{:else if origin}
			<p>{new URL(origin).host}: signed out</p>
		{/if}
		<div class="flex gap-2">
			<Button disabled={busy !== null} onclick={() => void signIn()}>
				{signedInAs ? 'Sign in again' : 'Sign in'}
			</Button>
			{#if signedInAs}
				<Button variant="outline" disabled={busy !== null} onclick={() => void signOut()}>Sign out</Button>
			{/if}
		</div>
		{#if waitingForBrowser}
			<p role="status">Finish signing in in your browser, then return here.</p>
		{/if}
		{#if accountError}<p role="alert" class="text-destructive">{accountError}</p>{/if}
	</div>
	<AiConnections />
{/if}

{#if localModels.available}
	<div class="grid gap-3 p-3" bind:this={sections.transcription}>
		<LocalModelAdministration />
	</div>
{:else}
	<Empty.Root class="h-full border-0">
		<Empty.Header>
			<Empty.Title>Settings live on the desktop</Empty.Title>
			<Empty.Description>
				Choosing the local transcription model needs the model files and the
				hardware on the machine running Epicenter, so it happens there.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}

