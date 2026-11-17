# Writing inbox

Save thoughts, quotes, and links. Find them when you sit down to write.
The browser, terminal, and your agent use the same actions and Markdown files.
No AI account or external service is needed.

Use the latest Epicenter CLI for a new home. Writing runs on 0.2.0 or later.
To add Writing to your home, run

```sh
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
epicenter serve
```

Open `http://localhost:4747/writing/`. Downloading the app requires Git and
network access. Using the copied app needs neither GitHub nor a provider key.

Open the app at `/<app>/` while `epicenter serve` runs. Capture text, an optional
source (a person, book, or URL), and an optional project. Search matches the text,
source, and project. A damaged note shows its file problem alongside matches.
A note with unreadable front matter appears in every search until repaired. Open a note to edit its text. Saving quotes the original
text; if it no longer matches, your draft stays in the editor so you can compare
it with the saved file.
Unsubmitted text is held only in the current page; keep the page open until saved.

For an app named writing:

```sh
epicenter writing add '{"body":"A small observation worth returning to"}'
epicenter writing add '{"body":"A quote from my reading","kind":"quote","source":"Book, page 42","project":"My essay"}'
epicenter writing search '{"query":"reading"}'
epicenter writing search '{"project":"My essay"}'
```

Use a returned time with `epicenter writing get '{"time":"TIME"}'` to read one
note. `epicenter writing add --help` lists the keys an action takes.
The CLI lists every action with `epicenter writing`. `set` changes fields,
and with `edit: { old, new }` it replaces an exact passage in the body, both
in one write. The UI changes only the body.
MCP offers the same actions at the server root. Start by asking an assistant
to find relevant notes, with their sources, before drafting anything new.

## Make it yours

Records live in sibling `data/notes/`. This `code/` folder is yours to change.
Ask your coding agent: "Add an optional topic field to the notes, show it on the
capture form, and include it in search. Keep existing notes readable."

`epicenter.ts` declares the fields and actions. `ui/main.ts` calls them through
`@epicenter/app/client`; `ui/index.html` and `ui/style.css` define the interface.
The next action call loads your changed code. Opening the page rebuilds changed
UI sources; a build keeps serving the last good version until it finishes.
`epicenter build writing` builds now and reports errors.

This app has no third-party app dependencies. Epicenter supplies
`@epicenter/app`. To add your own dependencies, run `bun add` in this code folder,
then `epicenter install writing` from your Epicenter. Changes in a shared copy
do not replace your changes.

History belongs to the Epicenter's private root repository. Make a named commit
before experimenting, and experiment outside the live folder. `git commit
-am 'Adapt my writing inbox'` records pending code and records together.
Keep the repository private: it contains your writing.

## Share your app

Commit the code you want to share in your private Epicenter, then export it to
a separate directory:

```sh
epicenter export writing "$PUBLIC_REPOSITORY/code"
```

Replace `PUBLIC_REPOSITORY` with the path to your publication repository.
Export regenerates `code/`; keep Git and handwritten publication files outside
that directory. Review the generated files, then commit and push with Git.
Your notes and private history are not exported. If this app is part of an
all-app collection, refresh that collection with its existing `export --all`
command instead of creating an export inside its generated directory.

## Take changes from another copy

`new --from` makes a new app. To update this app, ask your agent to inspect the
source and commit recorded in `code/SOURCE.md`, compare the incoming code in a
temporary folder outside your live Epicenter, and reconcile it with your edits.
Apply the reviewed changes only to `code/`, test them with your existing notes,
and inspect any record problems before making a named checkpoint. Keep `data/`.
Record the source revision you incorporated in `SOURCE.md`.

There is no automatic updater. Apps that start in your own Epicenter have no
`SOURCE.md` until you choose to incorporate code from elsewhere.
