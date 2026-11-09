<!--
	The page's leave guard: while `folder.saving()` (a write from its call, or
	an editor's keystroke, until it lands), leaving the page asks first (a
	browser's "Leave site?"). Closing a desktop window does not ask the page,
	so a local write still out then is a small, rare loss at the edge
	(ADR-0702). Writes waiting for an unreachable store live in the page's
	memory, so the guard matters most then (ADR-0775).

	```svelte
	<LeaveGuard {folder} />
	```

	`<WhenOpen>` renders one for its folder; a root that opens a folder of its
	own renders one beside it.
-->
<script lang="ts">
	import type { FolderLifecycle } from '@epicenter/folder/core';

	let { folder }: { folder: Pick<FolderLifecycle, 'saving'> } = $props();
</script>

<svelte:window
	onbeforeunload={(event) => {
		if (folder.saving()) event.preventDefault();
	}}
/>
