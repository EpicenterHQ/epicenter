/**
 * Preloaded before every test (`bunfig.toml`), so a test never depends on
 * the machine's own Git configuration: the global and system files are not
 * read, so no identity or LFS filter of this machine's leaks in; commits are
 * made as a test identity; and a new repository's first branch is `main`.
 * In-process runs read `process.env`. A spawned process inherits it when
 * given `env: process.env`; without that, Bun hands a child the environment
 * this process started with.
 */
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Epicenter Test';
process.env.GIT_AUTHOR_EMAIL = 'epicenter-test@example.com';
process.env.GIT_COMMITTER_NAME = 'Epicenter Test';
process.env.GIT_COMMITTER_EMAIL = 'epicenter-test@example.com';
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'init.defaultBranch';
process.env.GIT_CONFIG_VALUE_0 = 'main';
