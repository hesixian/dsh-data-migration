import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { EXCLUDED_DIRECTORY_NAMES, EXCLUDED_FILE_PATTERN, PROFILE_FILES, ROOT_DIRECTORIES, ROOT_FILES } from './constants.js'
import type { ScannedFile } from './types.js'

async function recursivelyCollect(root: string, current: string, output: ScannedFile[]): Promise<void> {
  const stat = await lstat(current); if (stat.isSymbolicLink()) return
  if (stat.isFile()) { if (stat.nlink === 1 && !EXCLUDED_FILE_PATTERN.test(basename(current))) output.push({ absolutePath: current, relativePath: relative(root, current).replaceAll('\\', '/') }); return }
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
/**
 * Names of the environment variables `settings.yaml` points its providers at.
 *
 * Scanned line by line rather than with a single end-of-line-anchored pattern,
 * because settings.yaml may use YAML flow style: the real home writes each
 * provider as `{ apiKeyEnv: NAME, models: [...] }`, so the name is followed by
 * a comma and the line does not end there. Anchoring to end-of-line silently
 * reported one provider out of five.
 *
 * A name only counts when the rest of the line is a delimiter or blank, which
 * keeps `apiKeyEnv: NOT_A_NAME here` and commented-out lines from registering.
 */
export function discoverApiKeyEnvNames(settingsYaml: string): string[] {
  const names = new Set<string>()
  for (const line of settingsYaml.split(/\r?\n/)) {
    const code = line.split('#')[0]
    for (const match of code.matchAll(/apiKeyEnv\s*:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g)) {
      const rest = code.slice(match.index + match[0].length)
      if (/^\s*(?:[,}\]]|$)/.test(rest)) names.add(match[1])
    }
  }
  return [...names].sort()
}
export async function discoverApiKeyEnvNamesInHome(home: string): Promise<string[]> { try { return discoverApiKeyEnvNames(await readFile(join(home, 'settings.yaml'), 'utf8')) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
