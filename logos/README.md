# Epicenter brand assets

The Epicenter mark is two overlapping circles, gray `#cccccc` behind white
`#ffffff`, designed for dark surfaces. This folder is the source of truth for it.

## Layout

```
logos/
  source/      canonical, hand-edited, SVG only (committed)
  generated/   raster derivatives, rebuilt from source/ (gitignored)
  generate.ts  the rebuild script
```

### `source/`

| File                          | What it is                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `epicenter-icon.svg`          | The mark, transparent background. Use for embeds on dark UI.                                   |
| `epicenter-icon-square.svg`   | The mark on a black square. Use when the containing surface supplies its own rounding or mask. |
| `epicenter-icon-squircle.svg` | The mark on a black squircle. Default app icon and favicon shape.                              |
| `epicenter-wordmark.svg`      | The mark above the word "epicenter" (Manrope).                                                 |

SVG is the canonical format: edit these, never the PNGs.

### `generated/`

| File                               | Source                        | Notes                            |
| ---------------------------------- | ----------------------------- | -------------------------------- |
| `epicenter-icon-1024.png`          | `epicenter-icon.svg`          | 8-bit sRGB, transparent.         |
| `epicenter-icon-square-1024.png`   | `epicenter-icon-square.svg`   | 8-bit sRGB.                      |
| `epicenter-icon-squircle-1024.png` | `epicenter-icon-squircle.svg` | 8-bit sRGB, transparent corners. |

PNG is the default generated raster format: it carries alpha and works
everywhere as an app icon, favicon, or social image. WebP/AVIF are not generated;
add them only as optional web-delivery copies if a site actually needs them.

## Rebuild

Requires ImageMagick (`brew install imagemagick`).

```bash
bun run logos/generate.ts
```

This rewrites everything in `generated/` from `source/`. It prints each output
and its dimensions.

## Wordmark raster (opt-in)

`generate.ts` does not rasterize the wordmark: its text needs the Manrope font,
which ImageMagick cannot resolve offline (the `@import` only loads in a browser),
so a plain `magick` call falls back to the wrong font.

To produce a faithful wordmark PNG, install a real SVG renderer and the font,
then render directly:

```bash
brew install librsvg font-manrope
rsvg-convert -w 1024 logos/source/epicenter-wordmark.svg \
  -o logos/generated/epicenter-wordmark-1024.png
```

For most uses, serve the wordmark as the SVG instead.

## App copies

Apps that serve a logo directly keep their own copy under `static/`/`public/`
(for example `sites/landing/public/favicon.svg`). Those mirror the shapes here;
update them by hand when the mark changes.
