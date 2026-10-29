/**
 * What an owner or repository name is: a letter, then lowercase letters,
 * digits and `-` (ADR-0693). So no name is `_app`, where the build serves
 * its files, and none has a dot, so no name is an app's hostname; `me` is
 * the one reserved name (you).
 */
export const NAME = /^[a-z][a-z0-9-]*$/;
