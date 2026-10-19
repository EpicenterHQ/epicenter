<script lang="ts">
	import { captureDefinition } from '$lib/definition.js';
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../epicenter.app.json';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// There is no sign-in on this path. Quitting Epicenter asks this page
	// nothing (ADR-0542).
</script>

<FolderApp app={manifest} definition={captureDefinition}><CaptureApp /></FolderApp>
