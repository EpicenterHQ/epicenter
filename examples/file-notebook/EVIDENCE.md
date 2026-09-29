# Acceptance evidence

Command, run from the repository root:

```sh
bun run --cwd examples/file-notebook acceptance
```

Observed again on 2026-09-30: 11 boundary tests passed and the Chromium walkthrough reported `"result": "pass"`. The JPEG's SHA-256 was `3c8aa85566a10a4a919ff9c61bdb4ba30d7df1b57164b04ae087a7a60f847752`; Git stored an LFS pointer for that digest and the desktop file contained the original 287 image bytes. The independent ZIP contained six paths and 1,307 bytes. Every recovered path and byte matched the pre-export snapshot, including malformed Markdown and an unfamiliar binary file. The recovered note's relative photo link resolved to the recovered image.

The walkthrough also observed browser just-bash reading the typed title, setting, and JPEG bytes; a browser edit during a held LFS upload remaining uncommitted; a browser commit preserving an unrelated repository file; Pull doing nothing when a local commit was ahead; Pull refusing genuinely divergent commits; and the desktop API rejecting a cross-origin terminal POST. It renamed the nondefault account folder from `trip-archive` to `trip-renamed`, checked that Git removed the old folder, and found the same relative photo link under the new folder.

`bun run --cwd examples/file-notebook typecheck` and `bun x vite build` passed. The fixture requires installed `git-lfs` and Playwright Chromium. The native arbitrary-writer check-to-rename race and unsupported incoming deletion remain the limits stated in the README.
