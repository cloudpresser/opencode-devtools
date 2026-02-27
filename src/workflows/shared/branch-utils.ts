/**
 * Shared branch name derivation utilities.
 *
 * - `deriveSlug`: converts a title to a URL-safe slug
 * - `deriveDevBranch`: creates a `dev/<id>-<slug>` branch name
 *
 * Used by implement and fix-defect workflows to create dev/ branches.
 * The plan workflow uses deriveSlug directly for feature/ and bug/ branches.
 */

/** Convert a title to a lowercase, hyphenated slug (max `maxLength` chars). */
export function deriveSlug(title: string, maxLength = 50): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

/** Derive a `dev/<id>-<slug>` branch name from a work item. */
export function deriveDevBranch(workItem: {
  id: number;
  title: string;
}): string {
  return `dev/${workItem.id}-${deriveSlug(workItem.title)}`;
}
