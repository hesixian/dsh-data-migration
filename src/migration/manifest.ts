import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FORMAT_VERSION } from './constants.js'
import { isAllowedArchivePath, isSafeRelativePath, listArchiveFiles } from './archive.js'
import type { ManifestFile, MigrationManifest } from './types.js'

const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }
export function validateManifestProfiles(manifest: MigrationManifest): string[] {
  if (!Array.isArray(manifest.meta?.profiles) || manifest.meta.profiles.some(profile => typeof profile !== 'string' || !SAFE_PROFILE_NAME.test(profile))) throw new Error('Invalid migration profiles')
  const declared = [...manifest.meta.profiles].sort(); if (new Set(declared).size !== declared.length) throw new Error('Duplicate migration profile')
  const derived = new Set<string>()
  for (const file of manifest.files) { const match = /^payload\/profiles\/([^/]+)\//.exec(file.path); if (match) { if (!SAFE_PROFILE_NAME.test(match[1])) throw new Error('Unsafe profile identifier'); derived.add(match[1]) } }
  const actual = [...derived].sort()
  if (declared.length !== actual.length || declared.some((profile, index) => profile !== actual[index])) throw new Error('Migration profile metadata mismatch')
  return actual
}
export function createManifest(entries: { path: string; data: Buffer }[], meta: Partial<MigrationManifest['meta']> = {}): MigrationManifest {
  const seen = new Set<string>(); const files: ManifestFile[] = entries.map(entry => { if (!isSafeRelativePath(entry.path) || !isAllowedArchivePath(entry.path) || entry.path === 'manifest.json') throw new Error(`Unsafe manifest path: ${entry.path}`); const key = entry.path.toLocaleLowerCase('en-US'); if (seen.has(key)) throw new Error('Duplicate manifest path'); seen.add(key); return { path: entry.path, size: entry.data.length, sha256: sha256(entry.data) } }).sort((a, b) => a.path.localeCompare(b.path))
  return { formatVersion: FORMAT_VERSION, createdAt: new Date().toISOString(), files, meta: { profiles: meta.profiles ?? [], apiKeyEnvNames: meta.apiKeyEnvNames ?? [], sensitiveCategories: meta.sensitiveCategories ?? [] } }
}
export async function validateManifest(staging: string, manifest: MigrationManifest): Promise<void> {
  if (manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.files)) throw new Error('Unsupported manifest')
  validateManifestProfiles(manifest)
  const expected = new Set<string>()
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path) || !isAllowedArchivePath(file.path) || file.path === 'manifest.json' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('Unsafe manifest path')
    const key = file.path.toLocaleLowerCase('en-US'); if (expected.has(key)) throw new Error('Duplicate manifest path'); expected.add(key)
    const full = join(staging, file.path); const stat = await lstat(full)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid manifest file')
    const bytes = await readFile(full); if (bytes.length !== file.size) throw new Error(`Manifest size mismatch: ${file.path}`); if (sha256(bytes) !== file.sha256) throw new Error(`Manifest hash mismatch: ${file.path}`)
  }
  const actual = await listArchiveFiles(staging); const actualSet = new Set(actual.map(path => path.toLocaleLowerCase('en-US')))
  if (!actualSet.delete('manifest.json') || actualSet.size !== expected.size || [...actualSet].some(path => !expected.has(path))) throw new Error('Unmanifested archive file')
}
