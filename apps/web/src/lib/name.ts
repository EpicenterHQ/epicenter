/**
 * What an owner or repository name is: a letter, then lowercase letters,
 * digits and `-`. So no name is `-`, under which the shell's own pages
 * live (`/-/storage`), or `_app`, where its build serves files; `me` is the
 * one reserved name (you).
 */
export const NAME = /^[a-z][a-z0-9-]*$/;
