<script lang="ts">
	import type { AuthClient, BrowserAuth } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { untrack } from 'svelte';

	let { selection, select, disabled = false, pending = $bindable(false) }: {
		selection: BrowserAuth;
		select: (action: () => ReturnType<NonNullable<AuthClient['startSignIn']>>) => ReturnType<NonNullable<AuthClient['startSignIn']>>;
		disabled?: boolean;
		pending?: boolean;
	} = $props();
	let url = $state(untrack(() => selection.selectedServer ?? ''));
	let changingServer = $state(false);
	let error = $state('');

	async function connect(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const connectInstance = selection.connectInstance;
		const result = await select(() => connectInstance({
			url: selection.selectedServer && !changingServer ? undefined : url,
		}));
		if (result.error) {
			error = 'Could not connect. Check the server address, then try again.';
			pending = false;
		}
	}

	async function useHosted() {
		pending = true;
		error = '';
		const useCloud = selection.useCloud;
		const result = await select(() => useCloud());
		if (result.error) {
			error = 'Could not change servers. Try again.';
			pending = false;
		}
	}
</script>

	<details open={!!selection.selectedServer || selection.auth === null} class="w-full text-left text-sm">
		<summary class="cursor-pointer py-2">Connect to your server</summary>
		<form class="flex flex-col gap-3 pt-2" onsubmit={connect}>
			{#if selection.selectedServer}
				<p class="break-all text-xs text-muted-foreground">Current server: {selection.selectedServer}</p>
				<Button type="button" variant="ghost" disabled={disabled || pending} onclick={() => changingServer = !changingServer}>{changingServer ? 'Keep current server' : 'Change server'}</Button>
			{/if}
			<Label>
				Server URL
				<Input type="url" placeholder="https://your-server.example" bind:value={url} required readonly={!!selection.selectedServer && !changingServer} disabled={disabled || pending} />
			</Label>
			<p class="text-xs text-muted-foreground">
				Sign in with a passkey on your server. Connecting reopens the app. Your existing local data stays on this device.
			</p>
			{#if error}
				<p role="alert" class="text-xs text-destructive">{error}</p>
			{/if}
			<Button type="submit" disabled={disabled || pending}>{pending ? 'Connecting…' : 'Connect'}</Button>
			{#if selection.selectedServer || selection.auth === null}
				<Button type="button" variant="outline" onclick={useHosted} disabled={disabled || pending}>Use Epicenter Cloud</Button>
			{/if}
		</form>
	</details>
