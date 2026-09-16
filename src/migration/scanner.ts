import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EXCLUDED_DIRECTORY_NAMES, PROFILE_FILES, ROOT_DIRECTORIES, ROOT_FILES } from './constants.js'
import type { ScannedFile } from './types.js'

async function recursivelyCollect(root: string, current: string, output: ScannedFile[]): Promise<void> {
  const stat = await lstat(current); if (stat.isSymbolicLink()) return
  if (stat.isFile()) { if (stat.nlink === 1) output.push({ absolutePath: current, relativePath: relative(root, current).replaceAll('\\', '/') }); return }
  if (!stat.isDirectory()) return
  for (const entry of await readdir(current)) { if (!EXCLUDED_DIRECTORY_NAMES.has(entry)) await recursivelyCollect(root, join(current, entry), output) }
}
async function maybeFile(root: string, path: string, output: ScannedFile[]): Promise<void> { try { await recursivelyCollect(root, path, output) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }

export async function scanDshHome(home: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = []
  for (const name of ROOT_FILES) await maybeFile(home, join(home, name), files)
  for (const name of ROOT_DIRECTORIES) await maybeFile(home, join(home, name), files)
  const profiles = join(home, 'profiles')
  try { for (const profile of await readdir(profiles)) { const profileRoot = join(profiles, profile); const stat = await lstat(profileRoot); if (stat.isSymbolicLink() || !stat.isDirectory()) continue; for (const file of PROFILE_FILES) await maybeFile(home, join(profileRoot, file), files); await maybeFile(home, join(profileRoot, 'data'), files) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}
export function discoverApiKeyEnvNames(settingsYaml: string): string[] { const names = new Set<string>(); for (const match of settingsYaml.matchAll(/^\s*apiKeyEnv\s*:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:#.*)?$/gm)) names.add(match[1]); return [...names].sort() }
export async function discoverApiKeyEnvNamesInHome(home: string): Promise<string[]> { try { return discoverApiKeyEnvNames(await readFile(join(home, 'settings.yaml'), 'utf8')) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
