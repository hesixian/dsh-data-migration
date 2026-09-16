import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { entriesFromFiles, packTarGz } from './archive.js'
import { encryptContainer } from './crypto.js'
import { createManifest, sha256 } from './manifest.js'
import { discoverApiKeyEnvNamesInHome, scanDshHome } from './scanner.js'
import { isAllowedApiKeyEnvName } from './env.js'
import { linkedDependenciesOf } from './links.js'
import { collectLinkedSources } from './sources.js'
import type { ExportResult, LinkedDependency, LinkedSource, ScannedFile } from './types.js'

/**
 * Every `link:` dependency across the exported profiles.
 *
 * These point at directories on *this* machine, so the report is the only way
 * the target machine can learn that it must supply them itself — an install
 * will happily "succeed" against a missing target.
 */
async function collectLinkedDependencies(files: ScannedFile[]): Promise<LinkedDependency[]> {
  const found: LinkedDependency[] = []
  for (const file of files) {
    const match = /^profiles\/([^/]+)\/package\.json$/.exec(file.relativePath)
    if (match === null) continue
    try {
      found.push(...linkedDependenciesOf(match[1], await readFile(file.absolutePath, 'utf8')))
    } catch {
      // An unreadable profile manifest surfaces later as a failed install.
    }
  }
  return found.sort((a, b) => a.profile.localeCompare(b.profile) || a.name.localeCompare(b.name))
}

export async function exportMigration(options: { home: string; destination: string; password: string; env?: NodeJS.ProcessEnv; includeLinkedSources?: boolean }): Promise<ExportResult> {
  if (options.password.length < 12) throw new Error('Migration password must be at least 12 characters')
  if (extname(options.destination) !== '.dsh-migrate') throw new Error('Migration destination must use .dsh-migrate')
  const files = await scanDshHome(options.home); const envNames = (await discoverApiKeyEnvNamesInHome(options.home)).filter(isAllowedApiKeyEnvName); const environment = options.env ?? process.env
  const envValues = Object.fromEntries(envNames.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]!]]))
  const payload = await entriesFromFiles(files); const profiles = [...new Set(files.map(file => /^profiles\/([^/]+)/.exec(file.relativePath)?.[1]).filter((x): x is string => Boolean(x)))].sort()
  const linkedDependencies = await collectLinkedDependencies(files)
  // Carrying the sources is what makes a `link:` profile survivable on another
  // machine; without it the package records the problem but cannot solve it.
  const carried = options.includeLinkedSources === true ? await collectLinkedSources(linkedDependencies) : { entries: [], sources: [] as LinkedSource[], skipped: [] }
  const secret = { path: 'secrets/env.json', data: Buffer.from(JSON.stringify(envValues), 'utf8') }
  const manifest = createManifest([...payload, ...carried.entries, secret], { profiles, apiKeyEnvNames: envNames, linkedDependencies, linkedSources: carried.sources, sensitiveCategories: files.some(file => file.relativePath === '.credentials.yaml') || envNames.length ? ['credentials'] : [] })
  const archive = await packTarGz([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...payload, ...carried.entries, secret])
  const encrypted = await encryptContainer(archive, options.password); await mkdir(dirname(options.destination), { recursive: true })
  const temp = `${options.destination}.${randomUUID()}.tmp`; await writeFile(temp, encrypted, { mode: 0o600 }); await rename(temp, options.destination)
  return { outputPath: options.destination, size: encrypted.length, sha256: sha256(encrypted), manifest }
}
