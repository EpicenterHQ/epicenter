<!--
	What every Svelte app mounts inside: the providers its controls share
	(tooltips, the confirmation dialog, toasts) around its root. An app is
	its own component tree, apart from the shell's, so it brings its own;
	the shell renders none of them, so nothing shows twice.
-->
<script lang="ts" generics="TProps extends Record<string, unknown>">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Component } from 'svelte';

	let { Root, props }: { Root: Component<TProps>; props: TProps } = $props();
</script>

<Tooltip.Provider><Root {...props} /></Tooltip.Provider>
<ConfirmationDialog />
<Toaster offset={16} closeButton />
