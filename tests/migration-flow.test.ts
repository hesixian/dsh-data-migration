import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packTarGz } from '../src/migration/archive.js'
import { encryptContainer } from '../src/migration/crypto.js'
import { applyEnvValues } from '../src/migration/env.js'
import { createManifest } from '../src/migration/manifest.js'
import { exportMigration } from '../src/migration/exporter.js'
import { applyMigration, preflightMigration } from '../src/migration/importer.js'
import { commandForProfile, scrubInstallEnvironment, spawnSpec } from '../src/migration/installer.js'
import { applyAtomically } from '../src/migration/snapshot.js'

describe('migration flow', () => {
  it('exports encrypted data then only applies after explicit confirmation', async () => {
    const source = await mkdtemp(join(tmpdir(), 'source-')); const target = await mkdtemp(join(tmpdir(), 'target-')); const output = join(await mkdtemp(join(tmpdir(), 'output-')), 'backup.dsh-migrate'); await mkdir(join(source, 'profiles', 'web', 'data'), { recursive: true }); await writeFile(join(source, 'settings.yaml'), 'apiKeyEnv: TEST_KEY\nmodel: migrated\n'); await writeFile(join(source, 'profiles', 'web', 'package.json'), '{}'); await writeFile(join(source, 'profiles', 'web', 'data', 'state.json'), '{}'); await writeFile(join(target, 'settings.yaml'), 'old')
    const exported = await exportMigration({ home: source, destination: output, password: 'correct twelve chars', env: { TEST_KEY: 'not-plaintext' } }); expect((await readFile(output)).includes(Buffer.from('not-plaintext'))).toBe(false); expect(exported.manifest.meta.apiKeyEnvNames).toEqual(['TEST_KEY'])
    const preview = await preflightMigration(output, 'correct twelve chars', target); expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('old')
    const values = new Map<string, string>(); const env = { get: (name: string) => values.get(name), set: (name: string, value: string) => { values.set(name, value) }, unset: (name: string) => { values.delete(name) } }
    await applyMigration(preview, { confirmSensitive: true, installDependencies: false, env }); expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toContain('migrated'); expect(values.get('TEST_KEY')).toBe('not-plaintext')
  })
  it('returns a snapshot rollback handle and rolls back atomic failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-')); await writeFile(join(root, 'settings.yaml'), 'old'); const applied = await applyAtomically(root, [{ relativePath: 'settings.yaml', data: Buffer.from('new') }]); expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe('new'); await applied.rollback(); await applied.rollback(); expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe('old'); await expect(applyAtomically(root, [{ relativePath: 'settings.yaml', data: Buffer.from('new') }], { failAfter: 1 })).rejects.toThrow(); expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe('old')
    const values = new Map([['ONE', 'old']]); const env = { get: (name: string) => values.get(name), set: (name: string, value: string) => { if (name === 'TWO') throw new Error('failure'); values.set(name, value) }, unset: (name: string) => { values.delete(name) } }; await expect(applyEnvValues(env, { ONE: 'new', TWO: 'x' })).rejects.toThrow(); expect(values.get('ONE')).toBe('old')
  })
  it('rolls back migrated files when environment application fails', async () => {
    const source = await mkdtemp(join(tmpdir(), 'rollback-source-')); const target = await mkdtemp(join(tmpdir(), 'rollback-target-')); const output = join(await mkdtemp(join(tmpdir(), 'rollback-output-')), 'backup.dsh-migrate'); await writeFile(join(source, 'settings.yaml'), 'apiKeyEnv: TEST_KEY\nvalue: new\n'); await writeFile(join(target, 'settings.yaml'), 'value: old\n')
    await exportMigration({ home: source, destination: output, password: 'correct twelve chars', env: { TEST_KEY: 'secret' } }); const preview = await preflightMigration(output, 'correct twelve chars', target)
    const failingEnv = { get: (_name: string) => undefined, set: () => { throw new Error('env failed') }, unset: () => {} }
    await expect(applyMigration(preview, { confirmSensitive: true, installDependencies: false, env: failingEnv })).rejects.toThrow(/env failed/); expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('value: old\n')
  })
  it('accepts only safe environment names and restores empty values', async () => {
    const values = new Map([['EMPTY', '']]); const env = { get: (name: string) => values.get(name), set: (name: string, value: string) => { if (name === 'SECOND') throw new Error('failure'); values.set(name, value) }, unset: (name: string) => { values.delete(name) } }
    await expect(applyEnvValues(env, { EMPTY: 'new', SECOND: 'x' })).rejects.toThrow(); expect(values.get('EMPTY')).toBe(''); await expect(applyEnvValues(env, { NODE_OPTIONS: 'bad' })).rejects.toThrow(/invalid/i)
  })
  it('rejects unsafe or payload-mismatched profile metadata before install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'profile-source-')); const output = join(home, 'invalid.dsh-migrate'); const payload = { path: 'payload/profiles/web/package.json', data: Buffer.from('{}') }; const secret = { path: 'secrets/env.json', data: Buffer.from('{}') }
    for (const profiles of [['../escape'], ['desktop']]) { const manifest = createManifest([payload, secret], { profiles, apiKeyEnvNames: [], sensitiveCategories: [] }); await writeFile(output, await encryptContainer(await packTarGz([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, payload, secret]), 'correct twelve chars')); await expect(preflightMigration(output, 'correct twelve chars', home)).rejects.toThrow(/profile/i) }
  })
  it('rejects export passwords shorter than twelve characters', async () => {
    const home = await mkdtemp(join(tmpdir(), 'short-password-')); const output = join(home, 'backup.dsh-migrate')
    await expect(exportMigration({ home, destination: output, password: 'short', env: {} })).rejects.toThrow(/at least 12/i)
  })
  it('only installs locked profiles with scripts disabled and scrubs secrets', () => {
    expect(commandForProfile('x', true)).toEqual(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']); expect(commandForProfile('x', false)).toEqual([])
    const clean = scrubInstallEnvironment({ PATH: 'safe-path', PATHEXT: '.COM;.EXE;.CMD', TEST_KEY: 'restored-secret', NODE_OPTIONS: '--require bad', HTTPS_PROXY: 'proxy' })
    expect(clean).toEqual({ PATH: 'safe-path', PATHEXT: '.COM;.EXE;.CMD', npm_config_ignore_scripts: 'true' })
  })
  it('routes the pnpm shim through cmd.exe on Windows and spawns it directly elsewhere', () => {
    const command = ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
    // A bare `.cmd` shim cannot be started by CreateProcess; without the shell
    // hop every Windows install failed with spawn-failed.
    expect(spawnSpec(command, 'win32', 'C:\\Windows\\system32\\cmd.exe')).toEqual({
      binary: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', ...command],
    })
    // A non-cmd.exe COMSPEC must not be trusted to run a `.cmd` shim.
    expect(spawnSpec(command, 'win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toEqual({
      binary: 'cmd.exe',
      args: ['/d', '/s', '/c', ...command],
    })
    expect(spawnSpec(command, 'linux')).toEqual({ binary: 'pnpm', args: command.slice(1) })
  })
})
