<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';

	let { onUnlock, error = '', apiOrigin = '' }: {
		onUnlock: (token: string) => void;
		error?: string;
		apiOrigin?: string;
	} = $props();
	let token = $state('');
</script>

<Empty.Root class="h-dvh">
	<Empty.Header>
		<Empty.Title>Codex Voice Queue</Empty.Title>
		<Empty.Description>{apiOrigin ? `Paste the access token for ${apiOrigin}` : 'Paste the access token printed by the gateway.'}</Empty.Description>
	</Empty.Header>
	<Empty.Content>
		<form
			class="flex w-full gap-2"
			onsubmit={event => {
				event.preventDefault();
				if (token.trim()) onUnlock(token.trim());
			}}
		>
			<Input type="password" aria-label="Access token" autocomplete="off" bind:value={token} />
			<Button type="submit" disabled={!token.trim()}>Unlock</Button>
		</form>
		{#if error}
			<p role="alert" class="text-destructive">{error}</p>
		{/if}
	</Empty.Content>
</Empty.Root>
