<!--
	Epicenter logo mark: two overlapping circles on a rounded tile. Matches the
	favicon at sites/landing/public/favicon.svg. Size it from the caller with a
	`class` (the viewBox scales).
-->
<script lang="ts">
	let { class: className }: { class?: string } = $props();
</script>

<svg
	viewBox="0 0 400 400"
	xmlns="http://www.w3.org/2000/svg"
	aria-hidden="true"
	class={className}
>
	<rect width="400" height="400" rx="60" fill="#000" />
	<circle cx="170" cy="170" r="100" fill="#ccc" />
	<circle cx="230" cy="230" r="100" fill="#fff" />
</svg>
