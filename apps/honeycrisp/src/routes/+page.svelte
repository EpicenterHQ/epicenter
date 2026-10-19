<!--
	Honeycrisp over this browser's local folder: `<FolderApp>` opens
	`openFolder({ tables: honeycrispTables })`, shows its loading and refusal
	screens, provides the folder to `NotesView`, and closes it when the page
	goes away.
-->
<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import { honeycrispTables } from '$lib/data.js';
	import NotesView from './components/NotesView.svelte';
</script>

<FolderApp title="Honeycrisp" tables={honeycrispTables}><NotesView /></FolderApp>
