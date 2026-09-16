import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { EXCLUDED_DIRECTORY_NAMES, EXCLUDED_FILE_PATTERN } from './constants.js'
import type { ArchiveEntry } from './archive.js'
import type { LinkedDependency, LinkedSource } from './types.js'

/**
 * Linked plugin sources carried inside a migration package.
 *
 * A `link:` dependency names an absolute directory on the source machine, and
 * these packages are almost never published — `dsh-safe-plugin` has no git
 * repository and no registry entry, `@deepseek-ai/dsh-switchblade` is a
 * workspace package that 404s on npm. The target machine therefore has no way
 * to reconstruct the directory, and `pnpm install` will not complain: it exits 0
 * against the missing target and leaves a dangling link. DSH then refuses to
 * boot the profile.
 *
 * Copying the directory into the package is the only fix that survives a
 * machine change. It is opt-in, the preview names every absolute path that will
 * be written, and a target that already exists is never overwritten.
 */

/**
 * Reserved subtree for carried sources. It lives under `payload/` so the
 * archive path rules need no widening, and it is dot-prefixed so it can never
 * collide with a real home directory of the same name.
 */
export const LINKED_SOURCE_PREFIX = 'payload/.migration-linked-sources'

/** Directories that are never worth carrying, alongside the home scan's own. */
const SOURCE_EXCLUDED_DIRECTORIES = new Set([...EXCLUDED_DIRECTORY_NAMES, '.git', '.idea', '.vscode', '.turbo'])

/** Caps keep a stray link target from turning a backup into a disk-filler. */
const MAX_SOURCE_FILES = 4_000
const MAX_SOURCE_BYTES = 64 * 1024 * 1024

/** Reduce a package name to a safe, collision-free archive path segment. */
function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The in-package prefix holding one linked source tree. */
export function sourcePrefix(profile: string, name: string): string {
  return `${LINKED_SOURCE_PREFIX}/${segment(profile)}/${segment(name)}`
}

interface WalkResult {
  paths: string[]
  bytes: number
  truncated: boolean
}

/** Collect the relative file paths of a directory, skipping symlinks and junk. */
async function walk(root: string, current = root, state: WalkResult = { paths: [], bytes: 0, truncated: false }): Promise<WalkResult> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (state.truncated) break
    const full = join(current, entry.name)
    // `withFileTypes` reports a symlink as neither file nor directory, which is
    // what keeps a link cycle or a junction out of the walk.
    if (entry.isDirectory()) {
      if (SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) continue
      await walk(root, full, state)
      continue
    }
    if (!entry.isFile()) continue
    if (EXCLUDED_FILE_PATTERN.test(entry.name)) continue
    if (state.paths.length >= MAX_SOURCE_FILES) {
      state.truncated = true
      break
    }
    state.paths.push(full)
  }
  return state
}

export interface CollectLinkedSourcesResult {
  entries: ArchiveEntry[]
  sources: LinkedSource[]
  /** Sources left out because their directory is absent or could not be read. */
  skipped: LinkedDependency[]
}

/**
 * Copy every resolvable `link:` target into archive entries.
 * @param dependencies - the profile `link:` dependencies found during export.
 * @param exists - seam for tests; defaults to the real filesystem.
 */
export async function collectLinkedSources(
  dependencies: LinkedDependency[],
  exists: (path: string) => Promise<boolean> | boolean = path =>
    readdir(path).then(() => true, () => false),
): Promise<CollectLinkedSourcesResult> {
  const entries: ArchiveEntry[] = []
  const sources: LinkedSource[] = []
  const skipped: LinkedDependency[] = []
  for (const dependency of dependencies) {
    if (!isAbsolute(dependency.target) || !(await exists(dependency.target))) {
      skipped.push(dependency)
      continue
    }
    const prefix = sourcePrefix(dependency.profile, dependency.name)
    let walked: WalkResult
    try {
      walked = await walk(dependency.target)
    } catch {
      skipped.push(dependency)
      continue
    }
    let bytes = 0
    let over = false
    for (const absolute of walked.paths) {
      const data = await readFile(absolute)
      if (bytes + data.length > MAX_SOURCE_BYTES) {
        over = true
        break
      }
      bytes += data.length
      entries.push({ path: `${prefix}/${absolute.slice(dependency.target.length + 1).replaceAll('\\', '/')}`, data })
    }
    if (over || walked.truncated) {
      // Partial carry is worse than none: it would restore a broken tree.
      for (let index = entries.length - 1; index >= 0 && entries[index].path.startsWith(`${prefix}/`); index -= 1) entries.splice(index, 1)
      skipped.push(dependency)
      continue
    }
    sources.push({
      profile: dependency.profile,
      name: dependency.name,
      target: dependency.target,
      prefix,
      fileCount: walked.paths.length,
      bytes,
    })
  }
  return { entries, sources, skipped }
}

export interface MaterializeResult {
  name: string
  target: string
  status: 'created' | 'already-present' | 'failed'
}

/** Is a directory non-empty? Used to decide whether a target needs recreating. */
async function hasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0
  } catch {
    return false
  }
}

/**
 * Restore carried sources to the absolute paths their `link:` specs name.
 *
 * An existing non-empty target is left untouched — the machine already has the
 * plugin, and overwriting someone's working checkout is not this tool's job.
 * @param sources - manifest entries describing what the package carries.
 * @param entries - archive entries, keyed by their in-package path.
 * @returns one result per source, and the directories this call created so the
 *   caller can undo them if a later step fails.
 */
export async function materializeLinkedSources(
  sources: LinkedSource[],
  entries: ArchiveEntry[],
): Promise<{ results: MaterializeResult[]; created: string[] }> {
  const results: MaterializeResult[] = []
  const created: string[] = []
  for (const source of sources) {
    if (!isAbsolute(source.target)) {
      results.push({ name: source.name, target: source.target, status: 'failed' })
      continue
    }
    if (await hasEntries(source.target)) {
      results.push({ name: source.name, target: source.target, status: 'already-present' })
      continue
    }
    try {
      const owned = entries.filter(entry => entry.path.startsWith(`${source.prefix}/`))
      for (const entry of owned) {
        const relative = entry.path.slice(source.prefix.length + 1)
        const full = join(source.target, relative)
        await mkdir(join(full, '..'), { recursive: true })
        await writeFile(full, entry.data, { mode: 0o600 })
      }
      created.push(source.target)
      results.push({ name: source.name, target: source.target, status: 'created' })
    } catch {
      results.push({ name: source.name, target: source.target, status: 'failed' })
    }
  }
  return { results, created }
}

/**
 * Remove directories created by {@link materializeLinkedSources}.
 *
 * Only ever called with paths this same run created, so it cannot delete a
 * pre-existing checkout.
 */
export async function undoMaterializedSources(created: string[]): Promise<void> {
  for (const path of created) await rm(path, { recursive: true, force: true })
}
