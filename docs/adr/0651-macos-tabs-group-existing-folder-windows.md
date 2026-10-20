# 0651. macOS tabs group existing folder windows

- **Status:** Proposed
- **Date:** 2026-10-20

## Context

Epicenter opens one native window per app and canonical directory. Each page
owns its drafts and save guard; the native window owns its directory binding.
Supporting tabs by moving child WebViews would introduce another close and
cleanup lifecycle. Tauri currently puts child WebView creation behind its
`unstable` feature.

## Decision

On macOS, AppKit may group existing folder windows as native tabs. Automatic
grouping respects the system tab preference. The Window menu can merge folder
windows, detach a tab, or close a tab group. Windows and Linux show separate
windows through the same folder opening path.

A tab keeps its original native window, label, page, and bound directory.
AppKit owns tab membership and selection. No tab registry, tab-to-folder map,
draft transfer, or persistent layout is added. Settings and the Folders
launcher use distinct identifiers and stay outside folder tab groups because
they hide on close.

Closing a group takes AppKit's window snapshot and calls `performClose` for
each member. Each page runs its existing save guard. A successful tab may
close while another stays open with unfinished input. A refusing tab focuses
itself before explaining why it stayed. Group closing is not atomic.
Application Quit retains its existing immediate behavior.

## Considered alternatives

Custom tabs over child WebViews would provide matching tab UI across platforms,
but would require a separate owner for tab closing, parent-window closing,
directory cleanup, and moving pages between windows. Native tabs preserve
the existing window lifetime at the cost of macOS-specific presentation.

## Verification

The opt-in `native_tabs` runtime example opens real Todos pages over temporary
native folders. It checks menu-driven group closing with unsent input, a held
save lock, and a filesystem save failure followed by retry. It also checks
page identity across detaching and merging, selection of a refusing background
tab, exclusion of Settings and Folders, and directory binding cleanup.
