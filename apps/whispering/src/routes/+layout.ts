// A client-only SPA: the folder opens after mount.
export const ssr = false;
// Epicenter's bundled build (ADR-0552) prerenders each page as an
// empty shell, so its assets load relative to wherever the host serves it and
// the router finds its base at run time. The browser build serves a fallback
// page.
export const prerender = import.meta.env.EPICENTER_HOST === '1';
