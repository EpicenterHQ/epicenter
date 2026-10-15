// Client-only SPA: the folder opens in the browser after mount.
export const ssr = false;
// The installed build (ADR-0552) prerenders each page as an empty shell, so
// its assets load relative to wherever the host serves it and the router
// finds its base at run time. The other builds serve a fallback page.
export const prerender = import.meta.env.EPICENTER_INSTALLED === '1';
