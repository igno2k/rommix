/** `owner/name` from a package.json's `repository` field. See repository.mjs. */
export function repositoryOf(pkg: { repository?: string | { url?: string } }): string
/** The repository of the package.json in `root`. */
export function repository(root?: string): string
