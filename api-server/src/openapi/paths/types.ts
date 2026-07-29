import type { PathItemObject } from 'openapi3-ts/oas31';

/** A partial `paths` map contributed by one resource's path-definition module. */
export type PathsFragment = Record<string, PathItemObject>;
