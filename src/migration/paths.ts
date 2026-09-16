/**
 * Migration path resolution.
 *
 * Both panels receive their location from the native Windows picker, which
 * hands back a DIRECTORY. A directory is therefore always the containing
 * folder of the canonical `backup.dsh-migrate`, while an explicit
 * `.dsh-migrate` path names the file itself. Resolution is deliberately
 * forgiving about the shapes Explorer and the dialog produce — trailing
 * separators, forward slashes, dot segments, mixed case — because rejecting
 * them surfaced to the user as an unexplained `invalid-request`.
 *
 * @module dsh-data-migration/migration/paths
 */

import { extname, isAbsolute, join, resolve } from 'node:path'

/** Canonical file name created inside a chosen folder. */
export const MIGRATION_FILE_NAME = 'backup.dsh-migrate'

/** Extension every migration container must carry. */
export const MIGRATION_EXTENSION = '.dsh-migrate'

/**
 * Normalize user input to an absolute path.
 * @throws when the value is blank.
 */
function absoluteFrom(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('A migration path is required')
  // `resolve` normalizes separators, dot segments and trailing slashes; an
  // already-absolute path keeps its drive/root, a relative one joins the cwd.
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(process.cwd(), trimmed)
}

/** Whether a resolved path names the migration container itself. */
export function isMigrationFile(path: string): boolean {
  return extname(path).toLowerCase() === MIGRATION_EXTENSION
}

/**
 * Resolve the export destination from a folder or an explicit file path.
 *
 * A folder — with or without a trailing separator — becomes
 * `<folder>/backup.dsh-migrate`. Any other extension is refused rather than
 * silently overwritten, so a mistyped destination can never clobber an
 * unrelated file.
 * @throws when the input is blank or carries a foreign extension.
 */
export function resolveExportDestination(value: string): string {
  const absolute = absoluteFrom(value)
  if (isMigrationFile(absolute)) return absolute
  if (extname(absolute) !== '') throw new Error(`Migration destination must use ${MIGRATION_EXTENSION}`)
  return join(absolute, MIGRATION_FILE_NAME)
}

/**
 * Resolve the import source from a `.dsh-migrate` file or its containing
 * folder. A folder falls back to the canonical `backup.dsh-migrate` inside it
 * so the folder picker keeps working for the default layout.
 * @throws when the input is blank.
 */
export function resolveImportSource(value: string): string {
  const absolute = absoluteFrom(value)
  if (isMigrationFile(absolute)) return absolute
  return join(absolute, MIGRATION_FILE_NAME)
}
