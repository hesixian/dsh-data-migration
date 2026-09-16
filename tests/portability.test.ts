import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportMigration } from '../src/migration/exporter.js'
import { applyMigration, preflightMigration, sweepStaleStaging, STAGING_TTL_MS } from '../src/migration/importer.js'
import { installProfiles, commandForProfile } from '../src/migration/installer.js'
import {
  buildScriptPackages,
  bundlesOf,
  dshInstallAnchor,
  linkedDependenciesOf,
  probeBundles,
  resolveLinkTarget,
} from '../src/migration/links.js'
import { discoverApiKeyEnvNames, scanDshHome } from '../src/migration/scanner.js'
import type { InstallResult } from '../src/migration/types.js'

/**
 * Portability cover.
 *
 * A migrated profile can carry two machine-local things that a fresh machine
 * cannot recreate: `link:` dependencies pointing at absolute source paths, and
 * `allowBuilds` packages whose build steps `--ignore-scripts` skips. Both fail
 * quietly — `pnpm install --frozen-lockfile` exits 0 against a missing link
 * target, and DSH then refuses to boot the profile. These tests pin the checks
 * that turn that silence into a report.
 */

const WEB_PACKAGE = JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {
    'registry-dep': '^1.0.0',
    'linked-dep': 'link:D:/code/linked-dep',
    'relative-linked': 'link:../sibling',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'linked-dep'] } },
})

describe('link dependency reporting', () => {
  it('collects every link: dependency with its profile and target', () => {
    expect(linkedDependenciesOf('web', WEB_PACKAGE)).toEqual([
      { profile: 'web', name: 'linked-dep', spec: 'link:D:/code/linked-dep', target: 'D:/code/linked-dep' },
      { profile: 'web', name: 'relative-linked', spec: 'link:../sibling', target: '../sibling' },
    ])
  })

  it('ignores registry and github specs', () => {
    const only = linkedDependenciesOf('tui', JSON.stringify({ dependencies: { a: '^1.0.0', b: 'github:o/r' } }))
    expect(only).toEqual([])
  })

  it('survives a malformed or dependency-less manifest', () => {
    expect(linkedDependenciesOf('web', '{ not json')).toEqual([])
    expect(linkedDependenciesOf('web', JSON.stringify({ name: 'x' }))).toEqual([])
    expect(linkedDependenciesOf('web', JSON.stringify({ dependencies: null }))).toEqual([])
  })

  it('resolves a relative link target against the profile directory', () => {
    expect(resolveLinkTarget('C:\\dsh\\profiles\\web', '../sibling')).toBe('C:\\dsh\\profiles\\sibling')
    expect(resolveLinkTarget('/home/u/.dsh/profiles/web', '/abs/target')).toBe('/abs/target')
  })

  it('reads the bundle list a profile asks DSH to load', () => {
    expect(bundlesOf(WEB_PACKAGE)).toEqual(['@deepseek-ai/dsh-base', 'linked-dep'])
    expect(bundlesOf(JSON.stringify({ name: 'x' }))).toEqual([])
    expect(bundlesOf(JSON.stringify({ dsh: { profile: { bundles: [1, 'ok'] } } }))).toEqual(['ok'])
  })

  it('reads the allowBuilds block without leaking into the next section', () => {
    const yaml = [
      'packages:',
      '  - .',
      'allowBuilds:',
      '  cloudflared: true',
      '  node-pty: true',
      'storeDir: D:\\code\\dsh\\.pnpm-store',
      'other:',
      '  nope: true',
    ].join('\n')
    expect(buildScriptPackages(yaml)).toEqual(['cloudflared', 'node-pty'])
    expect(buildScriptPackages('packages:\n  - .\n')).toEqual([])
  })
})

describe('bundle probing mirrors DSH resolution', () => {
  it('reports a bundle missing and conclusive when the installation was inspected', () => {
    const checks = probeBundles('C:\\nowhere\\profiles\\web', ['ghost-bundle'], 'web', {
      installAnchors: ['C:\\nowhere\\dsh\\package.json'],
      exists: () => false,
      readFile: () => '{}',
    })
    expect(checks).toEqual([
      {
        profile: 'web',
        bundle: 'ghost-bundle',
        dir: undefined,
        resolved: false,
        declaresPatch: false,
        conclusive: true,
      },
    ])
  })

  it('will not call an in-box bundle broken when no installation could be inspected', () => {
    // The dsh installation supplies bundles like @deepseek-ai/dsh-base. If the
    // probe cannot see that installation, an unresolved, undeclared bundle must
    // be reported as unverifiable — a false "broken" would denounce a working
    // profile.
    const undeclared = probeBundles('C:\\nowhere\\profiles\\web', ['@deepseek-ai/dsh-base'], 'web', {
      installAnchors: [],
      declared: new Set<string>(),
      exists: () => false,
      readFile: () => '{}',
    })
    expect(undeclared[0].conclusive).toBe(false)
    expect(undeclared[0].resolved).toBe(false)

    // A bundle the profile itself declares is a different matter: pnpm was
    // asked for it, so its absence is provable even without an installation.
    const declared = probeBundles('C:\\nowhere\\profiles\\web', ['linked-dep'], 'web', {
      installAnchors: [],
      declared: new Set(['linked-dep']),
      exists: () => false,
      readFile: () => '{}',
    })
    expect(declared[0].conclusive).toBe(true)
  })

  it('refuses to treat a non-dsh host process as the dsh installation', () => {
    // The running entry point is the only pointer to the installation, and it
    // must belong to the dsh app; otherwise a test runner would anchor at
    // itself and every in-box bundle would look missing.
    expect(process.argv[1]).toBeDefined()
    expect(dshInstallAnchor()).toBeUndefined()
  })

  it('distinguishes a resolved bundle from one that declares no dsh.bundle', () => {
    const profiles = 'C:\\home\\profiles\\web'
    const checks = probeBundles(profiles, ['has-patch', 'no-patch'], 'web', {
      installAnchors: [],
      exists: path => path.includes('node_modules'),
      readFile: path =>
        path.includes('has-patch')
          ? JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
          : JSON.stringify({ name: 'no-patch' }),
    })
    expect(checks[0].resolved).toBe(true)
    expect(checks[0].declaresPatch).toBe(true)
    expect(checks[1].resolved).toBe(true)
    expect(checks[1].declaresPatch).toBe(false)
  })
})

describe('install verification', () => {
  /** A spawn stub that reports success without running anything. */
  function succeedingSpawn(): typeof import('node:child_process').spawn {
    return (() => {
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] }
      process.nextTick(() => child.emit('close', 0))
      return child
    }) as unknown as typeof import('node:child_process').spawn
  }

  async function profileHome(packageJson: unknown): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'portability-'))
    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify(packageJson, null, 2))
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    return home
  }

  it('does not trust an exit code of 0 when a bundle cannot be resolved', async () => {
    // Regression: pnpm exits 0 against a missing link: target and leaves a
    // dangling symlink whose version reads 0.0.0. Reporting `installed` there
    // is what let a profile reach DSH in a state it refuses to boot.
    const home = await profileHome({
      dependencies: { 'ghost-bundle': 'link:D:/gone/ghost-bundle' },
      dsh: { profile: { bundles: ['ghost-bundle'] } },
    })
    const results = await installProfiles(home, ['web'], succeedingSpawn(), {}, {
      installAnchors: [join(home, 'no-install-anchor', 'package.json')],
    })
    const [result] = results as InstallResult[]
    expect(result.status).toBe('installed-with-broken-bundles')
    expect(result.ok).toBe(false)
    expect(result.brokenBundles).toEqual(['ghost-bundle'])
    expect(result.unverifiedBundles).toEqual([])
  })

  it('separates a provably broken bundle from one it cannot verify', async () => {
    // With no installation to inspect, an undeclared bundle is unverifiable
    // while a declared one is still provably broken.
    const home = await profileHome({
      dependencies: { 'linked-dep': 'link:D:/gone/linked-dep' },
      dsh: { profile: { bundles: ['linked-dep', '@deepseek-ai/dsh-base'] } },
    })
    const results = await installProfiles(home, ['web'], succeedingSpawn(), {}, { installAnchors: [] })
    const [result] = results as InstallResult[]
    expect(result.brokenBundles).toEqual(['linked-dep'])
    expect(result.unverifiedBundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(result.status).toBe('installed-with-broken-bundles')
  })

  it('reports installed when every bundle resolves with its patch', async () => {
    const home = await profileHome({ dsh: { profile: { bundles: ['real-bundle'] } } })
    const manifest = JSON.stringify({ name: 'real-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    const dir = join(home, 'profiles', 'web', 'node_modules', 'real-bundle')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), manifest)
    const results = await installProfiles(home, ['web'], succeedingSpawn(), {}, {
      installAnchors: [join(home, 'no-install-anchor', 'package.json')],
    })
    const [result] = results as InstallResult[]
    expect(result.status).toBe('installed')
    expect(result.ok).toBe(true)
    expect(result.brokenBundles).toEqual([])
  })

  it('names the packages whose build steps --ignore-scripts skipped', async () => {
    const home = await profileHome({ dsh: { profile: { bundles: [] } } })
    const profile = join(home, 'profiles', 'web')
    await writeFile(join(profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  cloudflared: true\n  absent-pkg: true\n')
    const built = join(profile, 'node_modules', 'cloudflared')
    await mkdir(built, { recursive: true })
    await writeFile(join(built, 'package.json'), JSON.stringify({ name: 'cloudflared', version: '0.7.3' }))
    const results = await installProfiles(home, ['web'], succeedingSpawn(), {}, {
      installAnchors: [join(home, 'no-install-anchor', 'package.json')],
    })
    expect((results as InstallResult[])[0].skippedBuilds).toEqual(['cloudflared'])
  })

  it('drops --ignore-scripts only when lifecycle scripts are allowed', () => {
    expect(commandForProfile('x', true)).toEqual(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'])
    expect(commandForProfile('x', true, false)).toEqual(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'])
    expect(commandForProfile('x', true, true)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
    expect(commandForProfile('x', false, true)).toEqual([])
  })
})

describe('api key discovery handles YAML flow style', () => {
  it('finds apiKeyEnv written with a trailing comma or brace', () => {
    // The real settings.yaml writes each provider as a flow mapping, so every
    // name but the last is followed by a comma; requiring end-of-line dropped
    // four of five providers from the migration report.
    const yaml = [
      'providers:',
      '  {',
      '    deepseek:',
      '      {',
      '        apiKeyEnv: DEEPSEEK_API_KEY,',
      '        models: [ { id: a } ]',
      '      },',
      '    ark: { apiKeyEnv: ARK_CODE_LATEST_API_KEY, models: [] },',
      '    opencode:',
      '      {',
      '        models: [],',
      '        apiKeyEnv: OPENCODE_GO_API_KEY',
      '      }',
      '  }',
    ].join('\n')
    expect(discoverApiKeyEnvNames(yaml)).toEqual([
      'ARK_CODE_LATEST_API_KEY',
      'DEEPSEEK_API_KEY',
      'OPENCODE_GO_API_KEY',
    ])
  })

  it('still rejects comments, empty values and trailing garbage', () => {
    expect(discoverApiKeyEnvNames('  # apiKeyEnv: COMMENTED_OUT\n')).toEqual([])
    expect(discoverApiKeyEnvNames('  apiKeyEnv:\n')).toEqual([])
    expect(discoverApiKeyEnvNames('  apiKeyEnv: TRAILING_GARBAGE here\n')).toEqual([])
  })
})

describe('scan scope carries plugin state but not stale locks', () => {
  async function buildHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'scope-'))
    const write = async (rel: string, text = '{}'): Promise<void> => {
      const full = join(home, rel)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, text)
    }
    await write('./settings.yaml', 'ui-theme:\n  preference: dark\n')
    await write('./.credentials.yaml', 'version: 1\n')
    await write('./pet.json')
    await write('./skin-center-active.json')
    await write('./task-board/ledger-v2.json')
    await write('./task-board/ledger-v2.lock')
    await write('./skin-center/wallpapers/.cache/we-tokens.json')
    await write('./data/whale-girl/state.json')
    await write('./dsh-usage/usage-ledger.json')
    await write('./dsh-usage/usage-ledger.json.32824.1789540795589.tmp')
    await write('./remote-web-ui-registry/web.json')
    await write('./dsh-session-archive/state.json')
    await write('./profiles/web/package.json', WEB_PACKAGE)
    await write('./profiles/web/pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    // Must never travel.
    await write('./sessions/s1.jsonl')
    await write('./.anonymous-user-id', 'anon')
    await write('./profiles/web/node_modules/dep/package.json')
    return home
  }

  it('collects plugin state the previous scope dropped', async () => {
    const home = await buildHome()
    const paths = (await scanDshHome(home)).map(file => file.relativePath)
    for (const expected of [
      'pet.json',
      'skin-center-active.json',
      'task-board/ledger-v2.json',
      'skin-center/wallpapers/.cache/we-tokens.json',
      'data/whale-girl/state.json',
      'dsh-usage/usage-ledger.json',
      'remote-web-ui-registry/web.json',
      'dsh-session-archive/state.json',
    ]) {
      expect(paths, `expected ${expected} to be migrated`).toContain(expected)
    }
  })

  it('keeps stale locks, temp files, sessions and node_modules out', async () => {
    const home = await buildHome()
    const paths = (await scanDshHome(home)).map(file => file.relativePath)
    for (const excluded of [
      'task-board/ledger-v2.lock',
      'dsh-usage/usage-ledger.json.32824.1789540795589.tmp',
      'sessions/s1.jsonl',
      '.anonymous-user-id',
      'profiles/web/node_modules/dep/package.json',
    ]) {
      expect(paths, `expected ${excluded} to stay behind`).not.toContain(excluded)
    }
  })
})

describe('carried link: sources make a profile portable', () => {
  async function fixture(): Promise<{ home: string; source: string; output: string }> {
    const home = await mkdtemp(join(tmpdir(), 'carry-home-'))
    const source = await mkdtemp(join(tmpdir(), 'carry-source-'))
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'private-plugin', version: '0.1.0' }))
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'lib', 'index.mjs'), 'export const name = "private-plugin"\n')
    await writeFile(join(source, 'cordis.patch.yml'), 'insert: []\n')
    // Junk that must not travel.
    await mkdir(join(source, 'node_modules', 'junk'), { recursive: true })
    await writeFile(join(source, 'node_modules', 'junk', 'index.js'), 'nope\n')
    await mkdir(join(source, '.git'), { recursive: true })
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(source, 'pnpm-lock.yaml.lock'), 'stale\n')

    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: { 'private-plugin': `link:${source.replaceAll('\\', '/')}` },
        dsh: { profile: { bundles: ['private-plugin'] } },
      }),
    )
    return { home, source, output: join(await mkdtemp(join(tmpdir(), 'carry-out-')), 'backup.dsh-migrate') }
  }

  it('copies the linked tree, skipping node_modules, .git and stale locks', async () => {
    const { home, output } = await fixture()
    const exported = await exportMigration({
      home,
      destination: output,
      password: 'correct twelve chars',
      env: {},
      includeLinkedSources: true,
    })
    const [declared] = exported.manifest.meta.linkedSources ?? []
    expect(declared).toBeDefined()
    expect(declared.name).toBe('private-plugin')
    expect(declared.fileCount).toBe(3)
    const paths = exported.manifest.files.map(file => file.path).filter(path => path.startsWith(declared.prefix))
    expect(paths).toHaveLength(3)
    expect(paths.some(path => path.includes('node_modules'))).toBe(false)
    expect(paths.some(path => path.includes('.git'))).toBe(false)
    expect(paths.some(path => path.endsWith('.lock'))).toBe(false)
    // The source directory itself is absent from the home scan, so the only
    // carrier is the linked-source subtree.
    expect(exported.manifest.files.some(file => file.path.startsWith('payload/profiles/web/package.json'))).toBe(true)
  })

  it('leaves the sources out when the caller does not opt in', async () => {
    const { home, output } = await fixture()
    const exported = await exportMigration({ home, destination: output, password: 'correct twelve chars', env: {} })
    expect(exported.manifest.meta.linkedSources).toEqual([])
    expect(exported.manifest.files.some(file => file.path.includes('.migration-linked-sources'))).toBe(false)
    // The dependency is still reported, so the panel can warn about it.
    expect(exported.manifest.meta.linkedDependencies).toHaveLength(1)
  })

  it('recreates the source on a machine that never had it, without touching the home', async () => {
    // The whole point of carrying: the plugin is unpublished and its link target
    // is absent on the target machine, yet the restore puts it back.
    const { home, source, output } = await fixture()
    await exportMigration({ home, destination: output, password: 'correct twelve chars', env: {}, includeLinkedSources: true })
    const original = await readFile(join(source, 'lib', 'index.mjs'))

    // Only now does the target machine "not have" the plugin.
    await rm(source, { recursive: true, force: true })
    expect(existsSync(source)).toBe(false)

    const target = await mkdtemp(join(tmpdir(), 'carry-target-'))
    const preflight = await preflightMigration(output, 'correct twelve chars', target)
    const applied = await applyMigration(preflight, { confirmSensitive: true, installDependencies: false })

    expect(applied.sources).toEqual([{ name: 'private-plugin', target: source.replaceAll('\\', '/'), status: 'created' }])
    expect(await readFile(join(source, 'lib', 'index.mjs'))).toEqual(original)
    expect(existsSync(join(source, 'node_modules'))).toBe(false)
    // Carried sources must never be unpacked into the home directory.
    expect(existsSync(join(target, '.migration-linked-sources'))).toBe(false)
    expect(existsSync(join(target, 'payload'))).toBe(false)
    // The profile manifest still points at the recreated directory.
    expect(await readFile(join(target, 'profiles', 'web', 'package.json'), 'utf8')).toContain('link:')
  })

  it('refuses to overwrite a target that already has content', async () => {
    const { home, source, output } = await fixture()
    await exportMigration({ home, destination: output, password: 'correct twelve chars', env: {}, includeLinkedSources: true })
    const mine = '# the checkout this machine already had\n'
    await writeFile(join(source, 'lib', 'index.mjs'), mine)

    const target = await mkdtemp(join(tmpdir(), 'carry-keep-'))
    const preflight = await preflightMigration(output, 'correct twelve chars', target)
    const applied = await applyMigration(preflight, { confirmSensitive: true, installDependencies: false })

    expect(applied.sources[0].status).toBe('already-present')
    expect(await readFile(join(source, 'lib', 'index.mjs'), 'utf8')).toBe(mine)
  })

  it('restores nothing when the caller turns materialization off', async () => {
    const { home, source, output } = await fixture()
    await exportMigration({ home, destination: output, password: 'correct twelve chars', env: {}, includeLinkedSources: true })
    await rm(source, { recursive: true, force: true })

    const target = await mkdtemp(join(tmpdir(), 'carry-off-'))
    const preflight = await preflightMigration(output, 'correct twelve chars', target)
    const applied = await applyMigration(preflight, {
      confirmSensitive: true,
      installDependencies: false,
      materializeSources: false,
    })
    expect(applied.sources).toEqual([])
    expect(existsSync(source)).toBe(false)
  })
})

describe('decrypted staging never outlives the operation', () => {
  it('keeps a fresh staging directory but removes an abandoned one', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'dsh-migration-fresh-'))
    await writeFile(join(fresh, 'manifest.json'), '{}')
    const abandoned = await mkdtemp(join(tmpdir(), 'dsh-migration-old-'))
    await writeFile(join(abandoned, 'manifest.json'), '{}')
    // Age the abandoned one past the time to live.
    const past = new Date(Date.now() - STAGING_TTL_MS - 60_000)
    await utimes(join(abandoned, 'manifest.json'), past, past)
    // A directory that merely shares the prefix is not ours to delete.
    const foreign = await mkdtemp(join(tmpdir(), 'dsh-migration-foreign-'))
    await writeFile(join(foreign, 'notes.txt'), 'not a migration package\n')
    await utimes(join(foreign, 'notes.txt'), past, past)

    const removed = await sweepStaleStaging()
    expect(removed).toContain(abandoned)
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(foreign)).toBe(true)

    await rm(fresh, { recursive: true, force: true })
    await rm(foreign, { recursive: true, force: true })
  })

  it('removes the staging directory when a preflight is applied', async () => {
    const home = await mkdtemp(join(tmpdir(), 'staging-home-'))
    await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
    const output = join(await mkdtemp(join(tmpdir(), 'staging-out-')), 'backup.dsh-migrate')
    await exportMigration({ home, destination: output, password: 'correct twelve chars', env: {} })
    const before = new Set(await readdir(tmpdir()))
    const preflight = await preflightMigration(output, 'correct twelve chars', await mkdtemp(join(tmpdir(), 'staging-target-')))
    const created = (await readdir(tmpdir())).filter(name => !before.has(name) && name.startsWith('dsh-migration-'))
    expect(created).toHaveLength(1)
    expect(existsSync(join(tmpdir(), created[0]))).toBe(true)
    await applyMigration(preflight, { confirmSensitive: true, installDependencies: false })
    expect(existsSync(join(tmpdir(), created[0]))).toBe(false)
  })
})

describe('export records link dependencies in the manifest', () => {
  it('lists every link: dependency so the target machine can be warned', async () => {
    const home = await mkdtemp(join(tmpdir(), 'export-links-'))
    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), WEB_PACKAGE)
    const destination = join(await mkdtemp(join(tmpdir(), 'export-out-')), 'backup.dsh-migrate')
    const exported = await exportMigration({ home, destination, password: 'correct twelve chars', env: {} })
    expect(exported.manifest.meta.linkedDependencies).toEqual([
      { profile: 'web', name: 'linked-dep', spec: 'link:D:/code/linked-dep', target: 'D:/code/linked-dep' },
      { profile: 'web', name: 'relative-linked', spec: 'link:../sibling', target: '../sibling' },
    ])
    // The package must still be readable and hash-verified after the change.
    expect((await readFile(destination)).length).toBeGreaterThan(0)
  })

  it('records an empty list when nothing is linked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'export-plain-'))
    await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
    const destination = join(await mkdtemp(join(tmpdir(), 'export-plain-out-')), 'backup.dsh-migrate')
    const exported = await exportMigration({ home, destination, password: 'correct twelve chars', env: {} })
    expect(exported.manifest.meta.linkedDependencies).toEqual([])
  })
})
