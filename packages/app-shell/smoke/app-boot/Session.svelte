<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fromAuth } from '@epicenter/auth/svelte';
	import AccountPopover from '../../src/account-popover/account-popover.svelte';
	import type { App } from '@epicenter/app/open';
	import { auth, type definition } from './application.js';
	import { probe } from './probe.js';
	import { getConnectionScreen, getSignOut } from '../../src/boot-screens/connection-screen-context.js';
	let { app }: { app: App<typeof definition> } = $props();
	let draft = $state('');
	const reactiveAuth = fromAuth(auth);
	const showPopover = new URL(location.href).searchParams.has('fail-signout');
	const connect = getConnectionScreen();
	const signOut = getSignOut();
	const leave = auth.getState().account
		? () => { void signOut?.().catch(() => {}).finally(() => probe.events.push('sign-out-action-finished'));  }
		: connect;
	// Ordinary work remains pending throughout departure; no owner registers it.
	// svelte-ignore state_referenced_locally
	app.device.kv.update({ text: 'accepted edit' });
	void probe.producer.then(() => probe.events.push('producer-finished'));
	probe.events.push('session-mounted');
	onDestroy(() => probe.events.push('session-destroyed'));
</script>

<svelte:window onbeforeunload={(event) => {
	if (!draft) return;
	probe.events.push('draft-beforeunload');
	event.preventDefault();
	event.returnValue = '';
}} />
<label>Draft<input bind:value={draft} onblur={() => {
	probe.events.push('focused-edit-committed');
	app.device.kv.update({ text: draft });
}} /></label>
<button onclick={leave}>Leave session</button>

<button onclick={connect}>Change account</button>

{#if showPopover}<AccountPopover auth={reactiveAuth} syncNoun="changes" />{/if}
