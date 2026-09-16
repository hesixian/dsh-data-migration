/**
 * Profile dependency restoration.
 *
 * A migrated profile deliberately arrives without `node_modules`, so the
 * installer re-creates it from the migrated lockfile. Three properties matter:
 *
 * - The install must actually launch on Windows, where `pnpm` is a `.cmd` shim
 *   CreateProcess cannot execute directly, so the command is handed to
 *   `cmd.exe` (the previous shape failed every Windows install with
 *   `spawn-failed`).
 * - The install must not inherit the restored API keys.
 * - The result must be *verified*. `pnpm install --frozen-lockfile` exits 0
 *   when a `link:` dependency's target is missing, leaving a dangling symlink
 *   whose version reads `0.0.0`. Reporting that as success is how a profile
 *   reaches DSH in a state it refuses to boot, so every bundle is probed
 *   afterwards and a profile with unresolvable bundles is reported as
 *   `installed-with-broken-bundles` rather than `installed`.
 *
 * @module dsh-data-migration/migration/installer
 */

import { access, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildScriptPackages, bundlesOf, dshInstallAnchor, probeBundles } from './links.js'
import type { InstallResult } from './types.js'

/** Environment variables the install subprocess may inherit. */
const INHERITED_ENVIRONMENT = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
] as const

/**
 * The install command for one profile; empty when it cannot be automated.
 * @param _profilePath - unused, kept for the existing call shape.
 * @param hasLockfile - a profile without a lockfile cannot be installed reproducibly.
 * @param allowScripts - when false, lifecycle scripts are disabled. That is the
 *   safe default, but it also skips the postinstall step that downloads
 *   `cloudflared`'s binary and the native builds `node-pty` needs.
 */
export function commandForProfile(_profilePath: string, hasLockfile: boolean, allowScripts = false): string[] {
  if (!hasLockfile) return []
  return allowScripts
    ? ['pnpm', 'install', '--frozen-lockfile']
    : ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
}

/**
 * Translate a logical command into something the platform can actually
 * execute. Windows cannot start a `.cmd` shim without a shell, so the command
 * is routed through the command interpreter; POSIX runs it directly.
 */
export function spawnSpec(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.COMSPEC,
): { binary: string; args: string[] } {
  const [binary = '', ...args] = command
  if (platform !== 'win32') return { binary, args }
  const shell = comspec !== undefined && comspec.toLowerCase().endsWith('cmd.exe') ? comspec : 'cmd.exe'
  return { binary: shell, args: ['/d', '/s', '/c', binary, ...args] }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Drop every restored secret and every runtime knob the installer must not inherit. */
export function scrubInstallEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of INHERITED_ENVIRONMENT) if (source[name] !== undefined) result[name] = source[name]
  result.npm_config_ignore_scripts = 'true'
  return result
}

export interface InstallOptions {
  /** Run lifecycle scripts instead of skipping them. Defaults to false. */
  allowScripts?: boolean
  /** DSH's first bundle-resolution anchor; tests inject one. */
  installAnchors?: string[]
}

/**
 * The packages this profile asks pnpm to build which the install skipped. Only
 * meaningful without `allowScripts`: these are exactly the builds
 * `--ignore-scripts` drops, and a dropped build is how `cloudflared` ends up
 * without its downloaded binary.
 */
async function skippedBuildsOf(profilePath: string, allowScripts: boolean): Promise<string[]> {
  if (allowScripts) return []
  const workspace = await readTextOrUndefined(join(profilePath, 'pnpm-workspace.yaml'))
  if (workspace === undefined) return []
  const skipped: string[] = []
  for (const name of buildScriptPackages(workspace)) {
    if (await exists(join(profilePath, 'node_modules', name, 'package.json'))) skipped.push(name)
  }
  return skipped
}

/** A failed install produces no bundle information. */
function failure(profile: string, status: InstallResult['status'], skippedBuilds: string[] = []): InstallResult {
  return { profile, ok: false, status, brokenBundles: [], unverifiedBundles: [], skippedBuilds }
}

/**
 * The dependency names a profile declares. An unresolved bundle that the
 * profile itself declares is provably broken — pnpm was asked for it and it is
 * not there — whereas an undeclared one may come from the dsh installation.
 */
function declaredDependencies(packageJsonText: string): Set<string> {
  const declared = new Set<string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJsonText)
  } catch {
    return declared
  }
  if (typeof parsed !== 'object' || parsed === null) return declared
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value === 'object' && value !== null) for (const name of Object.keys(value)) declared.add(name)
  }
  return declared
}

/**
 * Install the locked dependencies of every restored profile.
 * @param home - target DSH home.
 * @param profiles - profile directory names recorded in the manifest.
 * @param run - spawn seam for tests.
 * @param environment - process environment the scrubbed child environment derives from.
 * @param options - install behaviour; defaults keep the previous, safe shape.
 */
export async function installProfiles(
  home: string,
  profiles: string[],
  run: typeof spawn = spawn,
  environment: NodeJS.ProcessEnv = process.env,
  options: InstallOptions = {},
): Promise<InstallResult[]> {
  const allowScripts = options.allowScripts ?? false
  const anchor = dshInstallAnchor()
  const installAnchors = options.installAnchors ?? (anchor === undefined ? [] : [anchor])
  const results: InstallResult[] = []
  for (const profile of profiles) {
    const path = join(home, 'profiles', profile)
    if (!(await exists(join(path, 'package.json')))) {
      results.push(failure(profile, 'package-missing'))
      continue
    }
    const command = commandForProfile(path, await exists(join(path, 'pnpm-lock.yaml')), allowScripts)
    if (command.length === 0) {
      results.push(failure(profile, 'lockfile-missing'))
      continue
    }
    const spec = spawnSpec(command)
    const outcome = await new Promise<{ code: number | null; failed: boolean }>(resolve => {
      const child = run(spec.binary, spec.args, {
        cwd: path,
        shell: false,
        env: scrubInstallEnvironment(environment),
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      child.on('error', () => resolve({ code: null, failed: true }))
      child.on('close', code => resolve({ code, failed: false }))
    })
    if (outcome.failed) {
      results.push(failure(profile, 'spawn-failed'))
      continue
    }
    const skippedBuilds = await skippedBuildsOf(path, allowScripts)
    if (outcome.code !== 0) {
      results.push(failure(profile, 'install-failed', skippedBuilds))
      continue
    }
    // The install command exits 0 even against a missing `link:` target, so the
    // only trustworthy verdict is a probe of what DSH itself will resolve.
    const manifestText = await readTextOrUndefined(join(path, 'package.json'))
    const bundles = manifestText === undefined ? [] : bundlesOf(manifestText)
    const checks = probeBundles(path, bundles, profile, {
      installAnchors,
      declared: manifestText === undefined ? undefined : declaredDependencies(manifestText),
    })
    const brokenBundles = checks
      .filter(check => (check.resolved ? !check.declaresPatch : check.conclusive))
      .map(check => check.bundle)
    const unverifiedBundles = checks.filter(check => !check.resolved && !check.conclusive).map(check => check.bundle)
    results.push({
      profile,
      ok: brokenBundles.length === 0,
      status: brokenBundles.length === 0 ? 'installed' : 'installed-with-broken-bundles',
      brokenBundles,
      unverifiedBundles,
      skippedBuilds,
    })
  }
  return results
}
