<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../epicenter.app.json';
	import { honeycrispDefinition } from '$lib/data.js';
	import NotesView from './components/NotesView.svelte';

	// On the desktop, closing the window quits at once: every save is an atomic
	// rename into the folder, so nothing waits here (ADR-0542).
</script>

<FolderApp app={manifest} definition={honeycrispDefinition}><NotesView /></FolderApp>
