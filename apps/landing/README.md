# Epicenter website

This Astro app builds the homepage at [epicenter.so](https://epicenter.so/).
From the repository root, run `bun install` and `bun dev:landing` to work on it,
or `bun run --cwd apps/landing build` to generate `apps/landing/dist/`.

Pull requests get a Worker preview. A merge to main deploys the build to
[the landing Worker](https://landing.epicenter.workers.dev/). The public domain
is attached to a separate Cloudflare Pages project named `epicenter`, published
by direct upload. That deployment also serves the Mail verification page,
its privacy disclosures, and the archive.

To publish a homepage change on Pages, start with the current Pages site's
assets and replace the homepage and the assets it references from the new
build. Check the preview at `/`, `/mail`, and `/privacy` before publishing
to the production branch. Uploading the Worker build alone would drop the
Mail page.
