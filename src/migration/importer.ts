import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decryptContainer } from './crypto.js'
import { unpackTarGz } from './archive.js'
import { validateManifest, validateManifestProfiles } from './manifest.js'
import { applyEnvValues, processEnvironment, validateApiKeyEnvValues } from './env.js'
import { applyAtomically } from './snapshot.js'
import { installProfiles } from './installer.js'
import type { EnvironmentAdapter, MigrationManifest, PreflightResult } from './types.js'

interface Operation { staging: string; secrets: Record<string, string>; preview: PreflightResult; manifest: MigrationManifest; profiles: string[] }
const operations = new Map<string, Operation>()
export async function preflightMigration(packagePath: string, password: string, targetHome: string): Promise<PreflightResult> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-migration-'))
  try {
    await unpackTarGz(await decryptContainer(await readFile(packagePath), password), staging)
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as MigrationManifest
    await validateManifest(staging, manifest); const profiles = validateManifestProfiles(manifest)
    const secrets = validateApiKeyEnvValues(JSON.parse(await readFile(join(staging, 'secrets', 'env.json'), 'utf8')) as Record<string, unknown>)
    if (!Array.isArray(manifest.meta.apiKeyEnvNames)) throw new Error('Invalid migration environment metadata')
    const declaredNames = new Set(manifest.meta.apiKeyEnvNames)
    if (declaredNames.size !== manifest.meta.apiKeyEnvNames.length || [...declaredNames].some(name => typeof name !== 'string') || Object.keys(secrets).some(name => !declaredNames.has(name))) throw new Error('Undeclared migration environment variable')
    const operationId = randomUUID(); const preview = { operationId, targetHome, manifest, hasSensitiveData: Boolean(manifest.meta.sensitiveCategories.length || Object.keys(secrets).length) }
    operations.set(operationId, { staging, secrets, preview, manifest, profiles }); return preview
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
}
export async function applyMigration(preflight: PreflightResult, options: { confirmSensitive: boolean; installDependencies?: boolean; env?: EnvironmentAdapter } ): Promise<{ installs: Awaited<ReturnType<typeof installProfiles>> }> {
  const operation = operations.get(preflight.operationId)
  if (!operation || operation.preview !== preflight) throw new Error('Unknown or expired migration preflight')
  if (preflight.hasSensitiveData && !options.confirmSensitive) throw new Error('Sensitive migration confirmation is required')
  try {
    const replacements = operation.manifest.files.filter(file => file.path.startsWith('payload/')).map(async file => ({ relativePath: file.path.slice('payload/'.length), data: await readFile(join(operation.staging, file.path)) }))
    const applied = await applyAtomically(preflight.targetHome, await Promise.all(replacements))
    try { await applyEnvValues(options.env ?? processEnvironment, operation.secrets) } catch (error) { await applied.rollback(); throw error }
    return { installs: options.installDependencies === false ? [] : await installProfiles(preflight.targetHome, operation.profiles) }
  } finally { operations.delete(preflight.operationId); await rm(operation.staging, { recursive: true, force: true }) }
}
