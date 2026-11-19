# Epicenter brand assets

The Epicenter mark is two overlapping circles, gray `#cccccc` behind white
`#ffffff`, designed for dark surfaces. This folder is the source of truth for it.

## Files

| File                                  | What it is                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `source/epicenter-icon.svg`           | The mark, transparent background. Use for embeds on dark UI.                                   |
| `source/epicenter-icon-square.svg`    | The mark on a black square. Use when the containing surface supplies its own rounding or mask. |
| `source/epicenter-icon-squircle.svg`  | The mark on a black squircle. Default app icon and favicon shape.                              |
| `source/epicenter-wordmark.svg`       | The mark above the word "epicenter" (Manrope).                                                 |

The SVGs are the source of truth and are hand-edited. Nothing in the repo
generates rasters from them; export a PNG with your own tool when you need one.
The wordmark needs the Manrope font to render faithfully.

## App copies

Apps that serve a logo directly keep their own copy under `static/`/`public/`
(for example `apps/landing/public/favicon.svg`). Those mirror the shapes here;
update them by hand when the mark changes.
