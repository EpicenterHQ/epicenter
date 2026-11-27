<!-- Each settings section is its own page, named in the sidebar; this is the column they share. -->
<script lang="ts">
	let { children } = $props();
</script>

<main class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-xl flex-col gap-10 p-6">
		{@render children()}
	</div>
</main>
