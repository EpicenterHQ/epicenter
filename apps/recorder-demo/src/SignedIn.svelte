<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { onDestroy } from 'svelte';
	import Library from './Library.svelte';
	import { recorder } from './contract.ts';
	import { getDevice, setRemote } from './lib/context.ts';

	// One account for this component's life: `{#key}` above makes a new one
	// for a new account, and sign-out or replacement retires this remote.
	const { account }: { account: Account } = $props();

	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const remote = setRemote(openRemote(recorder, { account }));
	const uploader = startUploading(device, remote);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

<Library {remote} {uploader} />
