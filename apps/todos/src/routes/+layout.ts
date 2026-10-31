// Client-only SPA: the folder opens in the browser after mount.
export const ssr = false;
// The desktop build (`build:webview`) prerenders each page as an empty shell,
// so its assets load relative to wherever Todos' Tauri shell serves it and the
// router finds its base at run time. The browser build serves a fallback page.
export const prerender = import.meta.env.EPICENTER_DESKTOP === '1';
