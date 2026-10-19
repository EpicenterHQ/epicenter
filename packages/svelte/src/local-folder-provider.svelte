<!--
	Provides an opened local folder's context to its children:
	`getLocalFolder()` answers `context`, and svelte-query's
	`useQueryClient()` its query client. It closes nothing: whoever opened the
	folder closes it.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { type LocalFolderContext, setLocalFolder } from './local-folder-context.js';

	let {
		context,
		children,
	}: { context: LocalFolderContext<TTables>; children: Snippet } = $props();

	// Svelte sets context only while a component initializes; the provider
	// belongs to one folder for its life.
	// svelte-ignore state_referenced_locally
	setLocalFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
</script>

{@render children()}
