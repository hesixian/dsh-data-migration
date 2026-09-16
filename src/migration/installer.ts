/**
 * Profile dependency restoration.
 *
 * A migrated profile deliberately arrives without `node_modules`, so the
 * installer re-creates it from the migrated lockfile. Two properties matter:
 * the install runs with lifecycle scripts disabled and never inherits the
 * restored API keys, and it actually launches on Windows — where `pnpm` is a
 * `.cmd` shim that CreateProcess cannot execute directly, so the command has
 * to be handed to `cmd.exe` instead of being spawned bare (the previous shape
 * failed every Windows install with `spawn-failed`).
 *
 * @module dsh-data-migration/migration/installer
 */

import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
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

/** The install command for one profile; empty when it cannot be automated. */
export function commandForProfile(_profilePath: string, hasLockfile: boolean): string[] {
  return hasLockfile ? ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'] : []
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

/** Drop every restored secret and every runtime knob the installer must not inherit. */
export function scrubInstallEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of INHERITED_ENVIRONMENT) if (source[name] !== undefined) result[name] = source[name]
  result.npm_config_ignore_scripts = 'true'
  return result
}

/**
 * Install the locked dependencies of every restored profile.
 * @param home - target DSH home.
 * @param profiles - profile directory names recorded in the manifest.
 * @param run - spawn seam for tests.
 * @param environment - process environment the scrubbed child environment derives from.
 */
export async function installProfiles(
  home: string,
  profiles: string[],
  run: typeof spawn = spawn,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstallResult[]> {
  const results: InstallResult[] = []
  for (const profile of profiles) {
    const path = join(home, 'profiles', profile)
    if (!(await exists(join(path, 'package.json')))) {
      results.push({ profile, ok: false, status: 'package-missing' })
      continue
    }
    const command = commandForProfile(path, await exists(join(path, 'pnpm-lock.yaml')))
    if (command.length === 0) {
      results.push({ profile, ok: false, status: 'lockfile-missing' })
      continue
    }
    const spec = spawnSpec(command)
    results.push(
      await new Promise<InstallResult>(resolve => {
        const child = run(spec.binary, spec.args, {
          cwd: path,
          shell: false,
          env: scrubInstallEnvironment(environment),
          stdio: ['ignore', 'ignore', 'ignore'],
        })
        child.on('error', () => resolve({ profile, ok: false, status: 'spawn-failed' }))
        child.on('close', code =>
          resolve({ profile, ok: code === 0, status: code === 0 ? 'installed' : 'install-failed' }),
        )
      }),
    )
  }
  return results
}
