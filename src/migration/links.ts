/**
 * Dependency portability for migrated profiles.
 *
 * A profile's `package.json` can declare a dependency as `link:<path>`, which
 * points at a local directory on the *source* machine. `pnpm install
 * --frozen-lockfile` treats a missing link target as success — it exits 0 and
 * leaves a dangling symlink whose version reads `0.0.0` — so an install that
 * "succeeded" can still hand DSH a profile it refuses to boot. This module
 * supplies the two checks that turn that into a truthful report:
 *
 * - {@link probeBundles} mirrors DSH's own bundle resolution
 *   (`installAnchor` first, then the profile directory, each via
 *   `createRequire(anchor).resolve.paths`), so a bundle reported broken really
 *   is one DSH would refuse.
 * - {@link collectLinkedDependencies} and {@link buildScriptPackages} name the
 *   two machine-local things a fresh machine cannot recreate by itself.
 *
 * @module dsh-data-migration/migration/links
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { BundleCheck, LinkedDependency, ScannedFile } from './types.js'

/** `link:` is pnpm's local-directory protocol. */
const LINK_PREFIX = 'link:'

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Every `link:` dependency of one profile, in declaration order.
 * @param profile - profile directory name, recorded for the report.
 * @param packageJsonText - the profile's `package.json`.
 */
export function linkedDependenciesOf(profile: string, packageJsonText: string): LinkedDependency[] {
  const parsed = parseJson(packageJsonText)
  const dependencies = parsed?.['dependencies']
  if (typeof dependencies !== 'object' || dependencies === null) return []
  const found: LinkedDependency[] = []
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.startsWith(LINK_PREFIX)) {
      found.push({ profile, name, spec, target: spec.slice(LINK_PREFIX.length) })
    }
  }
  return found
}

/**
 * The bundle names a profile asks DSH to load.
 * @param packageJsonText - the profile's `package.json`.
 */
export function bundlesOf(packageJsonText: string): string[] {
  const parsed = parseJson(packageJsonText)
  const dsh = parsed?.['dsh']
  if (typeof dsh !== 'object' || dsh === null) return []
  const profile = (dsh as Record<string, unknown>)['profile']
  if (typeof profile !== 'object' || profile === null) return []
  const bundles = (profile as Record<string, unknown>)['bundles']
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
}

/**
 * The packages a profile asks pnpm to run build scripts for (`allowBuilds` in
 * `pnpm-workspace.yaml`). These are exactly the ones an `--ignore-scripts`
 * install silently skips, which is how `cloudflared` ends up without its
 * downloaded binary.
 */
export function buildScriptPackages(workspaceYaml: string): string[] {
  const names: string[] = []
  let inside = false
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^allowBuilds\s*:/.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    // A non-indented line ends the block.
    if (/^\S/.test(line)) break
    const match = /^\s+([@A-Za-z0-9._/-]+)\s*:/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

/** Resolve a `link:` target, which pnpm allows to be relative to the profile. */
export function resolveLinkTarget(profilePath: string, target: string): string {
  return isAbsolute(target) ? target : resolve(profilePath, target)
}

/**
 * Walk the node_modules chain Node itself would use from `anchor`, mirroring
 * `resolveBundleDir` in `@deepseek-ai/dsh-app-boot`. Bundles are resolved from
 * the installation first and the profile second, and hoisting means the answer
 * can live several directories above the profile.
 */
function packageDirFromAnchor(
  anchor: string,
  packageName: string,
  exists: (path: string) => boolean,
): string | undefined {
  let searchPaths: string[] | undefined
  try {
    searchPaths = createRequire(anchor).resolve.paths(packageName) ?? undefined
  } catch {
    return undefined
  }
  for (const searchPath of searchPaths ?? []) {
    const candidate = join(searchPath, packageName)
    if (exists(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** A file inside the running dsh installation, used as DSH's first anchor. */
export function defaultInstallAnchor(): string | undefined {
  return dshInstallAnchor()
}

/** A package whose name marks a path as living inside the dsh installation. */
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh'

/**
 * The dsh app package's `package.json`, used as DSH's first resolution anchor.
 *
 * DSH resolves every bundle against its own installation before the profile
 * directory, which is what keeps in-box bundles such as
 * `@deepseek-ai/dsh-base` coming from the running dsh rather than a
 * profile-local copy. Anchoring anywhere else makes those bundles look
 * missing.
 *
 * The running entry point is the only reliable pointer to the installation, and
 * it is *validated* before use: the nearest enclosing `package.json` must
 * belong to the dsh app. Without that check any host process — a test runner,
 * say — would anchor at itself and report every in-box bundle as broken.
 *
 * @returns the anchor path, or `undefined` when the installation cannot be
 *   located, in which case in-box bundles must be reported as unverifiable
 *   rather than broken.
 */
export function dshInstallAnchor(): string | undefined {
  const entry = process.argv[1]
  if (entry === undefined || !isAbsolute(entry)) return undefined
  let dir = dirname(entry)
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      let name: unknown
      try {
        name = (JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>)['name']
      } catch {
        return undefined
      }
      return typeof name === 'string' && name.startsWith(DSH_PACKAGE_PREFIX) ? manifest : undefined
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export interface ProbeOptions {
  /**
   * Path inside the dsh app package. Bundles resolve here first, as in DSH.
   * When omitted, {@link dshInstallAnchor} is consulted.
   */
  installAnchors?: string[]
  /** Names the profile declares as its own dependencies. */
  declared?: ReadonlySet<string>
  /** Seam for tests; defaults to the real filesystem. */
  exists?: (path: string) => boolean
  /** Seam for tests; defaults to the real filesystem. */
  readFile?: (path: string) => string
}

/**
 * Check every bundle of a profile the way DSH will at boot.
 *
 * `resolved` records whether a directory was found; `conclusive` records
 * whether a failure is *provable*. A bundle that is neither found nor a
 * declared profile dependency may legitimately be an in-box bundle supplied by
 * the dsh installation — but only if that installation could be inspected. When
 * it could not, the honest answer is "unverified", not "broken": a false alarm
 * here would tell someone their working profile is dead.
 */
export function probeBundles(
  profilePath: string,
  bundles: string[],
  profile: string,
  options: ProbeOptions = {},
): BundleCheck[] {
  const exists = options.exists ?? existsSync
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const installAnchors =
    options.installAnchors ?? (dshInstallAnchor() === undefined ? [] : [dshInstallAnchor()!])
  const sawInstallation = installAnchors.length > 0
  const anchors = [...installAnchors, join(profilePath, 'package.json')]
  return bundles.map(bundle => {
    let dir: string | undefined
    for (const anchor of anchors) {
      dir = packageDirFromAnchor(anchor, bundle, exists)
      if (dir !== undefined) break
    }
    if (dir !== undefined) {
      const manifest = parseJson(readFile(join(dir, 'package.json')))
      const dsh = manifest?.['dsh']
      const declared =
        typeof dsh === 'object' && dsh !== null
          ? ((dsh as Record<string, unknown>)['bundle'] as Record<string, unknown> | undefined)
          : undefined
      return { profile, bundle, dir, resolved: true, declaresPatch: typeof declared?.['patch'] === 'string', conclusive: true }
    }
    const declared = options.declared?.has(bundle) ?? false
    return { profile, bundle, dir: undefined, resolved: false, declaresPatch: false, conclusive: sawInstallation || declared }
  })
}

/**
 * Profile directories that carry a `package.json`, read from the scan, paired
 * with the file's text so the caller does not re-read them.
 */
export function profileManifests(files: ScannedFile[], contents: Map<string, string>): Map<string, string> {
  const profiles = new Map<string, string>()
  for (const file of files) {
    const match = /^profiles\/([^/]+)\/package\.json$/.exec(file.relativePath)
    if (match === null) continue
    const text = contents.get(file.relativePath)
    if (text !== undefined) profiles.set(match[1], text)
  }
  return profiles
}
