<script lang="ts">
	import { createTauriAuth } from '@epicenter/account/tauri';
	import { settings } from '@epicenter/local';
	import { reactive } from '@epicenter/svelte/reactive';
	import LocalModelAdministration from '@epicenter/transcription/local-model-administration';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Empty from '@epicenter/ui/empty';
	import { Label } from '@epicenter/ui/label';
	import { isTauri } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { commands } from './bindings.gen';

	/**
	 * Host-level administration (ADR-0189): the app's sign-in, starting at
	 * login, and the local transcription model (ADR-0180).
	 *
	 * The sign-in is the app's own, as `so.epicenter`, reaching every folder
	 * the person holds (ADR-0820): the shell signs in through the browser and
	 * keeps the token (`epicenter-account`), writing who is signed in to
	 * `account.json` in this computer's settings, which this page reads. A
	 * terminal's `epicenter auth login` is the CLI's own sign-in, which this
	 * section neither shows nor ends.
	 *
	 * The choice names files and an accelerator on this machine, so a browser or
	 * remote Home says where it lives instead of offering controls that would
	 * reach the wrong device.
	 */

	const desktop = isTauri();
	const local = reactive(settings);
	const auth = desktop ? reactive(createTauriAuth()) : null;

	let busy = $state<'signing-in' | 'signing-out' | null>(null);
	let accountError = $state('');
	let email = $state<string | null>(null);
	let startsAtLogin = $state<boolean | null>(null);

	onMount(() => {
		if (!desktop) return;
		void commands.startAtLogin().then(({ data, error }) => {
			if (error !== null) accountError = error;
			else startsAtLogin = data;
		});
	});

	/** Start at login, or stop, as the person checked. */
	async function startAtLogin(checked: boolean) {
		const { error } = await commands.setStartAtLogin(checked);
		if (error !== null) accountError = error;
		else startsAtLogin = checked;
	}

	const signIn = $derived(
		local.state().status === 'open' && auth ? auth.state() : null,
	);

	// Who is signed in, by email, once the shell says someone is.
	$effect(() => {
		const account = signIn?.account;
		email = null;
		if (account === undefined) return;
		void account.getProfile().then(({ data }) => {
			if (signIn?.account === account) email = data?.email ?? null;
		});
	});
</script>

{#if desktop && auth}
	<div class="grid gap-3 border-b p-3">
		<h2 class="font-medium">Account</h2>
		{#if local.state().status === 'failed'}
			<p role="alert" class="text-destructive">This computer's settings could not be read.</p>
		{:else if signIn === null}
			<p class="text-muted-foreground">Reading this computer's sign-in…</p>
		{:else if signIn.status === 'signed-out'}
			<p>{new URL(auth.baseURL || 'https://api.epicenter.so').host}: signed out</p>
		{:else}
			<p>
				Signed in to {new URL(signIn.account.baseURL).host}{#if email} as {email}{/if}.
				{#if signIn.status === 'reauth-required'}Sign in again to keep syncing.{/if}
			</p>
		{/if}
		<div class="flex gap-2">
			<Button
				disabled={busy !== null || signIn === null}
				onclick={async () => {
					busy = 'signing-in';
					accountError = '';
					const { error } = await auth.startSignIn();
					if (error !== null) accountError = error.message;
					busy = null;
				}}
			>
				{signIn?.status === 'signed-in' ? 'Sign in again' : 'Sign in'}
			</Button>
			{#if signIn && signIn.status !== 'signed-out'}
				<Button
					variant="outline"
					disabled={busy !== null}
					onclick={async () => {
						busy = 'signing-out';
						accountError = '';
						const { error } = await auth.signOut();
						if (error !== null) accountError = error.message;
						busy = null;
					}}
				>
					Sign out
				</Button>
			{/if}
		</div>
		{#if busy === 'signing-in'}
			<p role="status">Finish signing in in your browser, then return here.</p>
		{/if}
		{#if accountError}<p role="alert" class="text-destructive">{accountError}</p>{/if}
	</div>

	<div class="flex items-center gap-2 border-b p-3">
		<Checkbox
			id="start-at-login"
			disabled={startsAtLogin === null}
			bind:checked={() => startsAtLogin ?? false, (checked) => void startAtLogin(checked)}
		/>
		<Label for="start-at-login">
			Start Epicenter when you log in, so your folders stay in sync
		</Label>
	</div>

	<div class="grid gap-3 p-3">
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
