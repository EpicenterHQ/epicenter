/**
 * Todos' world for this page: the todos every page reads and edits. It is
 * bound once, before any page module runs, and never changes while the page
 * lives; whatever it depends on changing (another account, another data
 * folder) reloads the page.
 *
 * The build picks how it is bound (`#platform/app`): the signed-in person's
 * repository on the web (`app.web.ts`), the window's data folder on the
 * desktop (`app.tauri.ts`). A world that cannot open throws `StartupFailed`,
 * which `+error.svelte` shows as the recovery screen. Only what both builds
 * bind is here; a variant's own pieces (its account, its folder) are
 * imported from its leaf by that variant's components.
 */
export { todos } from '#platform/app';
