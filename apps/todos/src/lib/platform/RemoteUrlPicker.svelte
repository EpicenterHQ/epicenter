<script lang="ts">
	/**
	 * Connect, on the desktop: the remote is any Git URL the person's own Git
	 * can reach, with their own credential helper or SSH key. Epicenter allows
	 * only network URLs (`https://`, `ssh://`, `user@host:path`).
	 */
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import type { ConnectPickerProps } from './types.js';

	let { busy, onchoose }: ConnectPickerProps = $props();
	let url = $state('');
</script>

<form
	class="space-y-3"
	onsubmit={(event) => {
		event.preventDefault();
		if (url.trim()) onchoose(url.trim());
	}}
>
	<p class="text-sm text-muted-foreground">
		The Git remote to sync with, such as <code>https://github.com/you/todos.git</code>. Your own Git signs in to it.
	</p>
	<Input
		aria-label="Remote URL"
		class="font-mono"
		spellcheck={false}
		autocapitalize="off"
		placeholder="https://github.com/you/todos.git"
		bind:value={url}
		disabled={busy}
		data-testid="remote-url"
	/>
	<Button type="submit" disabled={busy || !url.trim()}>Connect</Button>
</form>
