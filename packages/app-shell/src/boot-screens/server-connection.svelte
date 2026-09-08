<script lang="ts">
	import { isBrowserAuth, type AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { untrack } from 'svelte';

	let { auth, disabled = false, pending = $bindable(false) }: { auth: AuthClient; disabled?: boolean; pending?: boolean } = $props();
	const client = $derived(isBrowserAuth(auth) ? auth : null);
	let url = $state(untrack(() => isBrowserAuth(auth) ? auth.selectedServer ?? '' : ''));
	let token = $state('');
	let error = $state('');

	async function connect(event: SubmitEvent) {
		event.preventDefault();
		if (!client) return;
		pending = true;
		error = '';
		const result = await client.connectInstance({ url, token });
		token = '';
		if (result.error) {
			error = 'Could not connect. Check the server address and token, then try again.';
			pending = false;
		}
	}

	async function useHosted() {
		if (!client) return;
		pending = true;
		error = '';
		const result = await client.useHostedServer();
		if (result.error) {
			error = 'Could not change servers. Try again.';
			pending = false;
		}
	}
</script>

{#if client}
	<details open={!!client.selectedServer} class="w-full text-left text-sm">
		<summary class="cursor-pointer py-2">Connect to your server</summary>
		<form class="flex flex-col gap-3 pt-2" onsubmit={connect}>
			{#if client.selectedServer}
				<p class="break-all text-xs text-muted-foreground">Current server: {client.selectedServer}</p>
			{/if}
			<Label>
				Server URL
				<Input type="url" placeholder="https://your-server.example" bind:value={url} required disabled={disabled || pending} />
			</Label>
			<Label>
				Server token
				<Input type="password" autocomplete="off" bind:value={token} required disabled={disabled || pending} />
			</Label>
			<p class="text-xs text-muted-foreground">
				Connecting reopens the app. Your existing local data stays on this device.
			</p>
			{#if error}
				<p role="alert" class="text-xs text-destructive">{error}</p>
			{/if}
			<Button type="submit" disabled={disabled || pending}>{pending ? 'Connecting…' : 'Connect'}</Button>
			{#if client.selectedServer}
				<Button type="button" variant="outline" onclick={useHosted} disabled={disabled || pending}>Use Epicenter Cloud</Button>
			{/if}
		</form>
	</details>
{/if}
