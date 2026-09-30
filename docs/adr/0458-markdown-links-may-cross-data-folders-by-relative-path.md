# 0458. Markdown links may cross data folders by relative path

- **Status:** Proposed
- **Date:** 2026-09-29
- **Relates:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) at attachment ownership.
- **Unbuilt:** resolution of cross-folder relative links in file-backed application views.

## Context

Separate data folders can hold notes, recordings, and files within one selected file scope. A note may need to display an image owned by a row in another folder. A link that works only through an Epicenter-specific URI loses its ordinary Markdown meaning when a person opens the files in an editor or moves that scope to another machine.

Giving each Markdown row at most one owned attachment does not limit the number of files its body may reference. Ownership and references answer different questions: which row deletes a file, and which documents use it.

## Decision

**A Markdown body may link to a file in another data folder within the same selected file scope using an ordinary relative path.** The path resolves from the directory containing the Markdown file. The data folders retain their relative placement when the scope is copied. A file-backed app that renders such a link resolves it against the opened scope rather than requiring a proprietary link scheme in the Markdown source. The link does not open or authorize another data folder; a target outside the explicitly opened file set remains unresolved. The physical `Epicenter/` parent does not implicitly open Local or every retained account folder.

```text
Epicenter/
  local/
    so.epicenter.notes/
      notes/
        n7.md
    so.epicenter.files/
      files/
        f2.md
        f2.jpg
```

In `n7.md`, `![photo](../../so.epicenter.files/files/f2.jpg)` targets the attachment owned by `f2.md`. A note can link to several file rows this way. The link does not give the note ownership of those attachments; deleting `n7.md` does not delete `f2.jpg`.

A note's own images can instead have owning rows in `so.epicenter.notes/`, keeping those bytes in a copy of that data folder. A cross-folder link is useful when the target already belongs to another data folder; it does not require a separate shared files folder for every image.

**A relative link does not make its target part of the source data folder.** Copying `so.epicenter.notes/` alone copies that folder's saved files but does not copy `f2.jpg`. Copying the shown `local/` scope with both folders preserves this link and includes the asset bytes. This rule does not define an export command, dependency-following copy, or link-rewriting rename procedure.

The names in the example illustrate the relative-path rule; this decision does not prescribe a home-directory location or require every installation to use these data folder names. The same link spelling works between sibling data folders in one account scope.

## Consequences

- Markdown editors and coding agents can follow or repair links using filesystem paths. An app needs a path resolver for its browser or native view of the same logical files.
- Moving or renaming a target file can break links in other data folders. An app that offers a path rename may repair references it can inspect in the opened scope. It cannot claim to have inspected unopened folders or files outside that scope. The complete filename stem supplies the row identity under [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md); there is no separately parsed readable suffix. Links include the target's literal extension.
- A single data folder remains copyable as its own source, but links outside it depend on the sibling folders being present. A product promising working cross-folder media in a one-folder export must copy those dependencies or rewrite the links.
- A link path reveals its folder and filename labels to anyone who can read the linking Markdown. A browser or device without the target folder mounted leaves the link unresolved; the link does not fetch or grant access to another scope.
- A renderer must constrain file access to the selected scope and explicitly opened file set when resolving links that contain `..`, including paths through symlinks on native filesystems. A link into another scope remains unresolved even if that target is present on disk. Filesystem path syntax alone does not impose that boundary.

## Considered alternatives

- Forbid links between data folders. This keeps each folder's links local but prevents notes from citing shared file rows as ordinary Markdown.
- Store `epicenter:` URLs in Markdown. The app could resolve stable row IDs, but common Markdown editors could not open the linked local files without an Epicenter-specific resolver.
- Copy every referenced asset into the linking folder. This duplicates bytes and gives the copy a second lifetime when several notes use one asset.
