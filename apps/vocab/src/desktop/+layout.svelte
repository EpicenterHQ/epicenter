<!--
	The desktop program's root (`VOCAB_DESKTOP=1` builds from `src/desktop`):
	the same chrome as the web build, the leave guard, which holds the
	window's close until its saves land, and nothing until the shell has said
	who, if anyone, is signed in.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { authReady } from '$lib/platform/auth.tauri.js';
	import '../app.css';

	let { children } = $props();

	// Closing the window or quitting waits for writes that are out.
	onMount(guardLeave);
</script>

<svelte:head><title>Vocab</title></svelte:head>

<Tooltip.Provider>
	{#await authReady then}{@render children?.()}{/await}
</Tooltip.Provider>

<Toaster />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
