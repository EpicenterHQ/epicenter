<!--
	Honeycrisp on the desktop: the same app as the web's, over the folder the
	native shell bound to this window (decisions 81 and 82: the shell asked on
	first run and remembers it in Honeycrisp's settings.md). The page opens it
	as Honeycrisp's contract client and names no path; it never signs in.
	Epicenter syncs the folder once the person asks it to ("Sync with
	Epicenter").
-->
<script lang="ts">
	import { openDevice } from '@epicenter/folder/tauri';
	import { fromClient } from '@epicenter/svelte/client';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import { honeycrisp } from '$lib/contract.js';
	import { setDesktopFolder } from '$lib/desktop-context.js';
	import { createDesktopFolder } from '$lib/desktop-folder.svelte.js';

	// The page's one store for its life.
	const device = openDevice(honeycrisp);
	setDesktopFolder(createDesktopFolder());
</script>

<HoneycrispApp view="desktop" client={fromClient(device)} />
