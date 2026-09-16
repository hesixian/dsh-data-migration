import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExportDestination, resolveImportSource } from '../src/migration/paths.js'

/**
 * Regression cover for the folder-picker contract: both the export and the
 * import panel hand this plugin a FOLDER chosen through the native dialog, so
 * a directory input must resolve to the canonical `backup.dsh-migrate` inside
 * it instead of being rejected as an invalid request.
 */
describe('migration path resolution', () => {
  const folder = join(resolve('.'), 'backup-folder')

  it('treats a folder as the containing directory for export', () => {
    expect(resolveExportDestination(folder)).toBe(join(folder, 'backup.dsh-migrate'))
  })

  it('accepts trailing separators, forward slashes and dot segments', () => {
    expect(resolveExportDestination(folder + '\\')).toBe(join(folder, 'backup.dsh-migrate'))
    expect(resolveExportDestination(folder + '/')).toBe(join(folder, 'backup.dsh-migrate'))
    expect(resolveExportDestination(folder + '\\.')).toBe(join(folder, 'backup.dsh-migrate'))
  })

  it('keeps an explicit .dsh-migrate file destination, including uppercase', () => {
    const file = join(folder, 'my-backup.dsh-migrate')
    expect(resolveExportDestination(file)).toBe(file)
    expect(resolveExportDestination(file.toUpperCase())).toBe(file.toUpperCase())
  })

  it('rejects an export destination with a foreign extension', () => {
    expect(() => resolveExportDestination(join(folder, 'my-backup.zip'))).toThrow(/dsh-migrate/i)
  })

  it('resolves an import source from either the file or its folder', () => {
    const file = join(folder, 'my-backup.dsh-migrate')
    expect(resolveImportSource(file)).toBe(file)
    expect(resolveImportSource(folder)).toBe(join(folder, 'backup.dsh-migrate'))
    expect(resolveImportSource(folder + '\\')).toBe(join(folder, 'backup.dsh-migrate'))
  })

  it('rejects blank input', () => {
    expect(() => resolveExportDestination('   ')).toThrow()
    expect(() => resolveImportSource('')).toThrow()
  })
})
