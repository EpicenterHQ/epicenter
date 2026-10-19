<!--
	Provides an opened local folder's context to its children:
	`getFolder()` answers `context`, and svelte-query's
	`useQueryClient()` its query client. It closes nothing: whoever opened the
	folder closes it.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { type FolderContext, setFolder } from './folder-context.js';

	let {
		context,
		children,
	}: { context: FolderContext<TTables>; children: Snippet } = $props();

	// Svelte sets context only while a component initializes; the provider
	// belongs to one folder for its life.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
</script>

{@render children()}
