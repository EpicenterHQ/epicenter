# Share the writing app

`writing/` is generated code exported from the Writing app maintained in an
Epicenter. Its notes stay in that Epicenter's private `apps/writing/data/`.
People take the exported files by copying the folder, as with any other shared app.
There is no named template or bundled writing app in the CLI.

To refresh this code after changing the maintained app, export it from your
private Epicenter. Export saves a local checkpoint before copying code:

```sh
epicenter export writing "$REPOSITORY/examples/writing"
```

Replace `REPOSITORY` with the path to this checkout. Export replaces every
generated file in `writing/`; keep handwritten publication files outside it.
Review the result, then commit and publish the code with Git. Do not put notes
or credentials into this directory.

After these files are published, a developer can take their own copy
from the top of their home:

```sh
mkdir -p apps/writing/code
curl -L https://github.com/EpicenterHQ/epicenter/archive/main.tar.gz | tar -xz -C apps/writing/code --strip-components=3 epicenter-main/examples/writing
bun install && bun run build
```

Each recipient owns their copy and its records. Source changes are compared
and adapted deliberately; refreshing this export does not update their apps.
