<!--
	Provides an opened folder's context to its children: `getFolder()` answers
	`context`, and svelte-query's `useQueryClient()` its query client.
	`<FolderApp>` mounts it once the app's folder is open; a test mounts views
	inside it over a test folder. It closes nothing: whoever opened the folder
	closes it.
-->
<script lang="ts" generics="TDefinition extends Definition">
	import type { Definition } from '@epicenter/folder';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { type FolderContext, setFolder } from './folder-context.js';

	let {
		context,
		children,
	}: { context: FolderContext<TDefinition>; children: Snippet } = $props();

	// Svelte sets context only while a component initializes; the provider
	// belongs to one folder for its life.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
</script>

{@render children()}
