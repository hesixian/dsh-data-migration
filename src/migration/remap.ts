import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import type { LinkedDependency, LinkedSource, RemapEntry, RemapPlan, StoreDirDrop } from './types.js'

export type { RemapEntry, RemapPlan, StoreDirDrop } from './types.js'

/** Where carried plugin sources go when their recorded path is unusable. */
export const RELOCATED_PLUGINS_DIRECTORY = 'linked-plugins'

/** Is the root of this absolute path present — on Windows, does that drive exist? */
export function rootAvailable(path: string, exists: (candidate: string) => boolean = existsSync): boolean {
  if (!isAbsolute(path)) return false
  const root = parse(path).root
  return root.length > 0 && exists(root)
}

/** Profile files that pin a pnpm store location. */
const STORE_DIR_FILES = [
  ['pnpm-workspace.yaml', /^\s*storeDir\s*:\s*(.+?)\s*$/m],
  ['.npmrc', /^\s*store-dir\s*=\s*(.+?)\s*$/m],
] as const

export interface PlanOptions {
  sources: LinkedSource[]
  dependencies: LinkedDependency[]
  targetHome: string
  /**
   * Reads a profile-relative file out of the package payload. The store directory
   * that needs dropping lives in the *package*, not in the target home, which has
   * not been restored yet when this plan is made.
   */
  readProfileFile: (profile: string, name: string) => string | undefined
  /** Seam for tests; defaults to the real filesystem. */
  exists?: (candidate: string) => boolean
}

/**
 * Decide what has to move.
 *
 * A recorded target that is still usable stays exactly where it is: someone
 * restoring onto an identically laid out machine expects their checkouts to
 * remain put. Only an unusable target is relocated, and only when the package
 * actually carries that source.
 */
export function planRemap(options: PlanOptions): RemapPlan {
  const exists = options.exists ?? existsSync
  const carried = new Set(options.sources.map(source => `${source.profile}\0${source.name}`))
  const entries: RemapEntry[] = []
  for (const dependency of options.dependencies) {
    if (rootAvailable(dependency.target, exists)) continue
    if (!carried.has(`${dependency.profile}\0${dependency.name}`)) continue
    entries.push({
      profile: dependency.profile,
      name: dependency.name,
      from: dependency.target,
      to: join(options.targetHome, RELOCATED_PLUGINS_DIRECTORY, dependency.name),
    })
  }
  const storeDirs: StoreDirDrop[] = []
  for (const profile of new Set(options.dependencies.map(dependency => dependency.profile))) {
    for (const [name, pattern] of STORE_DIR_FILES) {
      const match = pattern.exec(options.readProfileFile(profile, name) ?? '')
      if (match === null) continue
      const value = match[1].replace(/^["']|["']$/g, '')
      if (!rootAvailable(value, exists)) storeDirs.push({ profile, value })
      break
    }
  }
  return { entries, storeDirs }
}

/** Rewrite every declaration that names a relocated source. */
function rewriteLinks(text: string, entries: RemapEntry[]): string {
  let result = text
  for (const entry of entries) {
    // pnpm records these specs with forward slashes; keep that spelling.
    const target = `link:${entry.to.replaceAll('\\', '/')}`
    for (const spelling of new Set([entry.from, entry.from.replaceAll('\\', '/')])) {
      result = result.split(`link:${spelling}`).join(target)
    }
  }
  return result
}

/** Drop a `storeDir` line pinned to a drive this machine does not have. */
function stripStoreDir(text: string, value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*(?:storeDir\\s*:\\s*|store-dir\\s*=\\s*)["']?${escaped}["']?\\s*$`)
  return text
    .split(/\r?\n/)
    .filter(line => !pattern.test(line))
    .join('\n')
}

/** Files this module rewrites, relative to a profile directory. */
const REWRITABLE = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'] as const

export interface RemapResult {
  /** Profile-relative paths actually modified. */
  rewritten: string[]
}

/**
 * Apply a plan to files already restored on disk.
 *
 * Runs after the home restore, so the pre-migration contents are in the
 * snapshot and a later failure rolls these rewrites back with everything else.
 */
export async function applyRemap(targetHome: string, plan: RemapPlan): Promise<RemapResult> {
  const rewritten: string[] = []
  const profiles = new Set([...plan.entries.map(entry => entry.profile), ...plan.storeDirs.map(drop => drop.profile)])
  for (const profile of profiles) {
    const entries = plan.entries.filter(entry => entry.profile === profile)
    const drops = plan.storeDirs.filter(drop => drop.profile === profile)
    for (const name of REWRITABLE) {
      const full = join(targetHome, 'profiles', profile, name)
      let text: string
      try {
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      let next = entries.length === 0 ? text : rewriteLinks(text, entries)
      for (const drop of drops) next = stripStoreDir(next, drop.value)
      if (next === text) continue
      await writeFile(full, next, { mode: 0o600 })
      rewritten.push(`profiles/${profile}/${name}`)
    }
  }
  return { rewritten }
}

/** Destination each carried source should be materialized to, keyed by profile+name. */
export function remapDestinations(plan: RemapPlan): Map<string, string> {
  return new Map(plan.entries.map(entry => [`${entry.profile}\0${entry.name}`, entry.to]))
}
