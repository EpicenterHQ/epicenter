<!--
	Join a synced repository: make this browser's copy of `owner`'s
	repository on a server, syncing as an account. Until accounts exist, the
	account is any name the development server takes as whom it is from
	(`Authorization: Bearer <name>`). A link
	`/<owner>/<repository>?server=<url>` fills in all but the account.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { join, type Manifest, ownerOf, YOU } from './device.svelte.js';

	let {
		owner = '',
		repository = '',
		server = '',
		onJoined,
	}: {
		/** The owner as an address names them (`me`: you); empty to ask. */
		owner?: string;
		repository?: string;
		server?: string;
		onJoined: (manifest: Manifest) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let form = $state({ owner, repository, server, account: '' });
	let failure = $state<string>();
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = undefined;
		const joined = await join({
			owner: ownerOf(form.owner.trim() || YOU),
			repository: form.repository.trim(),
			url: form.server.trim(),
			account: form.account.trim(),
		});
		busy = false;
		if (joined.error !== null) failure = joined.error.message;
		else onJoined(joined.data);
	}
</script>

<form class="space-y-3 rounded-md border p-3" aria-label="Join a synced repository" onsubmit={submit}>
	<h2 class="text-sm font-medium">Join a synced repository</h2>
	<label class="block space-y-1 text-sm">
		<span>Server</span>
		<Input bind:value={form.server} type="url" placeholder="http://127.0.0.1:8787/" required />
	</label>
	<label class="block space-y-1 text-sm">
		<span>Owner <span class="text-muted-foreground">(me for you)</span></span>
		<Input bind:value={form.owner} placeholder={YOU} pattern="[a-z][a-z0-9\-]*" />
	</label>
	<label class="block space-y-1 text-sm">
		<span>Repository</span>
		<Input bind:value={form.repository} required pattern="[a-z][a-z0-9\-]*" />
	</label>
	<label class="block space-y-1 text-sm">
		<span>Sync as</span>
		<Input bind:value={form.account} required />
	</label>
	{#if failure !== undefined}
		<p class="text-sm text-destructive" role="alert">{failure}</p>
	{/if}
	<Button type="submit" disabled={busy}>Join</Button>
</form>
