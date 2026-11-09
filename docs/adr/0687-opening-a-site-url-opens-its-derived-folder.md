# 0687. Opening a site URL opens its derived folder

- **Status:** Superseded
- **Superseded by:** [ADR-0701](0701-apps-run-as-separate-programs.md): Epicenter opens no site URL.
- **Date:** 2026-10-24
- **Revisits:** [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md), which chose a host-downloaded release and a saved folder association.
- **Unbuilt:** Production host-owned offline reopening as proposed in [ADR-0691](0691-offline-reopening-keeps-the-sites-https-origin.md); Windows and Linux origin checks; migration of remaining bundled apps. A [macOS Tauri fixture](../../apps/epicenter/evidence/offline-proxy/RESULTS.md) has proved native Folder IPC at the site's HTTPS origin.

## Context

The archive design made a URL into a second installation protocol. Epicenter
downloaded a tar, stored a release, served it from a custom origin, remembered
an area association, and exposed Update. The browser already loads the SPA from
the publisher's URL. Requiring another artifact and update path made the
desktop behave unlike the browser and complicated local development.

## Decision

Opening a canonical HTTPS root URL in Epicenter opens that website in a native
WebView. The hostname reverses into one child of the Epicenter folder:
`https://todos.acme.dev` opens `~/Epicenter/dev.acme.todos`. Opening the URL
is the user decision that gives the publisher's current code access to that
one area. The host creates a missing child and reuses an existing one. It
stores no site installation, code release, or site-to-folder association.

The host binds the window to the derived directory before loading the page.
Only that window and HTTPS origin receive the Folder plugin. The site cannot
choose a path; top-level navigation stays on its origin. Built-in and bundled
pages retain their local scheme during migration. A publisher serves a normal
website. A standard service worker may make it available offline in browsers;
Epicenter's proposed host-owned reopening is examined in
[ADR-0691](0691-offline-reopening-keeps-the-sites-https-origin.md). The host
does not build the site.

## Consequences

- Whoever controls the hostname later controls the code that can read and
  edit its area. There is no host-enforced build provenance or rollback.
- An existing folder is opened without another prompt. A missing folder is
  recreated, so moving data elsewhere must be explicit.
- Today, offline launch depends on the website's own offline support and
  retained WebView data. A running page can keep editing its local Folder
  after the required code has loaded. Host-owned offline reopening remains
  unbuilt under ADR-0691.
- Browser storage and native Folder storage remain separate despite sharing
  the URL.
- The old archive, Update command, and machine-local association records are
  left on disk unread. Legacy bundled apps remain available during migration.
