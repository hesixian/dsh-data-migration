import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { readFileSync, rmSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decryptContainer } from './crypto.js'
import { unpackTarGz } from './archive.js'
import { validateManifest, validateManifestProfiles } from './manifest.js'
import { applyEnvValues, processEnvironment, validateApiKeyEnvValues } from './env.js'
import { applyAtomically } from './snapshot.js'
import { installProfiles } from './installer.js'
import { LINKED_SOURCE_PREFIX, materializeLinkedSources, undoMaterializedSources } from './sources.js'
import { applyRemap, planRemap, remapDestinations } from './remap.js'
import type { EnvironmentAdapter, LinkedSource, MaterializeResult, MigrationManifest, PreflightResult } from './types.js'

interface Operation { staging: string; secrets: Record<string, string>; preview: PreflightResult; manifest: MigrationManifest; profiles: string[]; createdAt: number }
const operations = new Map<string, Operation>()

/** Prefix of the staging directories this module creates under the temp dir. */
const STAGING_PREFIX = 'dsh-migration-'

/**
 * A preflight decrypts the whole package — credentials included — into a temp
 * directory. That plaintext must not outlive the operation, so staging is
 * removed when the apply finishes, for every staging directory this process
 * created when the process exits, and for anything an earlier process left
 * behind.
 *
 * That last case is the one that bites: a user who previews a package and then
 * closes the panel leaves their API keys sitting in `%TEMP%` in the clear.
 */
const ownedStaging = new Set<string>()

/** How long an unapplied preflight may keep its decrypted staging directory. */
export const STAGING_TTL_MS = 30 * 60 * 1000

/**
 * Delete staging directories older than {@link STAGING_TTL_MS}.
 *
 * The age check is what makes this safe to run while other dsh processes are
 * alive: a live operation is seconds old, so it is never a candidate. Only
 * directories carrying a `manifest.json` — this module's own shape — are
 * touched.
 * @returns the directories that were removed.
 */
export async function sweepStaleStaging(now: number = Date.now()): Promise<string[]> {
  const removed: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue
    const full = join(tmpdir(), entry.name)
    if (ownedStaging.has(full)) continue
    try {
      const info = await stat(join(full, 'manifest.json'))
      if (!info.isFile() || now - info.mtimeMs < STAGING_TTL_MS) continue
      await rm(full, { recursive: true, force: true })
      removed.push(full)
    } catch {
      // Not one of ours, or another process is mid-read; leave it alone.
    }
  }
  return removed
}

/** Forget and delete one staging directory this process owns. */
async function releaseStaging(dir: string): Promise<void> {
  ownedStaging.delete(dir)
  await rm(dir, { recursive: true, force: true })
}

// A host that is killed or restarted would otherwise strand the plaintext.
process.once('exit', () => {
  for (const dir of ownedStaging) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort only: the process is already going away.
    }
  }
})

/**
 * Reject a `linkedSources` list that is not shaped as this tool writes it.
 *
 * The list decides which absolute directories a restored package will create,
 * so it is validated as strictly as the profile metadata is.
 */
function validateLinkedSources(manifest: MigrationManifest): LinkedSource[] {
  const declared = manifest.meta.linkedSources
  if (declared === undefined) return []
  if (!Array.isArray(declared)) throw new Error('Invalid linked source metadata')
  for (const source of declared) {
    if (typeof source !== 'object' || source === null) throw new Error('Invalid linked source metadata')
    if (typeof source.name !== 'string' || typeof source.target !== 'string' || typeof source.prefix !== 'string') throw new Error('Invalid linked source metadata')
    if (!source.prefix.startsWith(`${LINKED_SOURCE_PREFIX}/`)) throw new Error('Unsafe linked source prefix')
    if (!Number.isSafeInteger(source.fileCount) || source.fileCount < 0) throw new Error('Invalid linked source metadata')
  }
  return declared
}

export async function preflightMigration(packagePath: string, password: string, targetHome: string): Promise<PreflightResult> {
  await sweepStaleStaging()
  // A long-lived host must also drop preflights it never applied, otherwise
  // their decrypted staging directories survive until the process exits.
  for (const [id, operation] of operations) {
    if (Date.now() - operation.createdAt < STAGING_TTL_MS) continue
    operations.delete(id)
    await releaseStaging(operation.staging)
  }
  const staging = await mkdtemp(join(tmpdir(), STAGING_PREFIX))
  ownedStaging.add(staging)
  try {
    await unpackTarGz(await decryptContainer(await readFile(packagePath), password), staging)
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as MigrationManifest
    await validateManifest(staging, manifest); const profiles = validateManifestProfiles(manifest)
    validateLinkedSources(manifest)
    const secrets = validateApiKeyEnvValues(JSON.parse(await readFile(join(staging, 'secrets', 'env.json'), 'utf8')) as Record<string, unknown>)
    if (!Array.isArray(manifest.meta.apiKeyEnvNames)) throw new Error('Invalid migration environment metadata')
    const declaredNames = new Set(manifest.meta.apiKeyEnvNames)
    if (declaredNames.size !== manifest.meta.apiKeyEnvNames.length || [...declaredNames].some(name => typeof name !== 'string') || Object.keys(secrets).some(name => !declaredNames.has(name))) throw new Error('Undeclared migration environment variable')
    // A profile exported on a machine with more drives than this one names paths
    // that cannot exist here. Work out what must move before the user confirms,
    // so the preview can show it.
    const remap = planRemap({
      sources: manifest.meta.linkedSources ?? [],
      dependencies: manifest.meta.linkedDependencies ?? [],
      targetHome,
      readProfileFile: (profile, name) => {
        try {
          return readFileSync(join(staging, 'payload', 'profiles', profile, name), 'utf8')
        } catch {
          return undefined
        }
      },
    })
    const operationId = randomUUID(); const preview = { operationId, targetHome, manifest, hasSensitiveData: Boolean(manifest.meta.sensitiveCategories.length || Object.keys(secrets).length), remap }
    operations.set(operationId, { staging, secrets, preview, manifest, profiles, createdAt: Date.now() }); return preview
  } catch (error) { await releaseStaging(staging); throw error }
}

export interface ApplyOptions {
  confirmSensitive: boolean
  installDependencies?: boolean
  allowScripts?: boolean
  /** Recreate the carried `link:` sources; defaults to yes when present. */
  materializeSources?: boolean
  env?: EnvironmentAdapter
}

export interface ApplyResult {
  installs: Awaited<ReturnType<typeof installProfiles>>
  sources: MaterializeResult[]
  /** Profile-relative files whose `link:`/`storeDir` declarations were rewritten. */
  rewritten: string[]
}

export async function applyMigration(preflight: PreflightResult, options: ApplyOptions): Promise<ApplyResult> {
  const operation = operations.get(preflight.operationId)
  if (!operation || operation.preview !== preflight) throw new Error('Unknown or expired migration preflight')
  if (preflight.hasSensitiveData && !options.confirmSensitive) throw new Error('Sensitive migration confirmation is required')
  try {
    const payload = operation.manifest.files.filter(file => file.path.startsWith('payload/'))
    // Carried sources live under a reserved payload subtree and restore to their
    // own absolute paths, never into the home directory.
    const homeFiles = payload.filter(file => !file.path.startsWith(`${LINKED_SOURCE_PREFIX}/`))
    const sourceFiles = payload.filter(file => file.path.startsWith(`${LINKED_SOURCE_PREFIX}/`))
    const replacements = await Promise.all(homeFiles.map(async file => ({ relativePath: file.path.slice('payload/'.length), data: await readFile(join(operation.staging, file.path)) })))
    const applied = await applyAtomically(preflight.targetHome, replacements)
    let created: string[] = []
    let rewritten: string[] = []
    try {
      // Relocate unusable absolute paths, then place the carried sources where
      // the rewritten declarations now point.
      const remapped = await applyRemap(preflight.targetHome, preflight.remap)
      rewritten = remapped.rewritten
      await applyEnvValues(options.env ?? processEnvironment, operation.secrets)
      let sources: MaterializeResult[] = []
      const declaredSources = operation.manifest.meta.linkedSources ?? []
      if (options.materializeSources !== false && declaredSources.length > 0) {
        const entries = await Promise.all(sourceFiles.map(async file => ({ path: file.path, data: await readFile(join(operation.staging, file.path)) })))
        const materialized = await materializeLinkedSources(declaredSources, entries, remapDestinations(preflight.remap))
        created = materialized.created
        sources = materialized.results
      }
      const installs = options.installDependencies === false ? [] : await installProfiles(preflight.targetHome, operation.profiles, undefined, undefined, { allowScripts: options.allowScripts ?? false })
      return { installs, sources, rewritten }
    } catch (error) {
      // Undo in the reverse order of creation: the directories this run made,
      // then the home files.
      await undoMaterializedSources(created)
      await applied.rollback()
      throw error
    }
  } finally { operations.delete(preflight.operationId); await releaseStaging(operation.staging) }
}
