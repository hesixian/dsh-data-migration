import { defineConfig } from 'tsdown'

/**
 * Two artifacts, both consumed through `package.json#exports`:
 *
 * - `lib/index.mjs` — the host half (routes, crypto, installer), plain ESM.
 * - `lib/client.js`  — the browser half the module host serves for `./client`.
 *
 * The browser half is the ONLY client source. The previous layout kept a
 * hand-written `client.js` at the repository root beside a second, divergent
 * `src/client/index.ts`, so a change applied to one half silently missed the
 * bundle that actually shipped. `exports["./client"]` now points at the build
 * output, which makes "fix the source and forget to rebuild" impossible.
 *
 * The client bundle is emitted as CJS and wrapped in the module host's
 * registration call, because the host does not evaluate a bundle as a module:
 * a bundle only registers a factory through
 * `window.__ModuleLoader__.load({ id, factory })`, and everything else —
 * including module-body side effects — runs later at materialization.
 */

/** Must equal the package name: the host keys the browser module by it. */
const CLIENT_ID = 'dsh-data-migration'

const external = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-slots',
  'react',
  'react/jsx-runtime',
  'react-dom',
]

export default defineConfig([
  {
    name: 'dsh-data-migration:host',
    entry: { index: 'src/index.ts' },
    format: 'esm',
    outDir: 'lib',
    clean: true,
    dts: true,
    sourcemap: true,
    external,
  },
  {
    name: 'dsh-data-migration:client',
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    outDir: 'lib',
    clean: false,
    dts: true,
    sourcemap: true,
    external,
    outputOptions: {
      entryFileNames: 'client.js',
      intro: [
        'window.__ModuleLoader__.load({',
        `\tid: ${JSON.stringify(CLIENT_ID)},`,
        '\tfactory: (require) => {',
        '\t\tvar module = { exports: {} };',
        '\t\tvar exports = module.exports;',
      ].join('\n'),
      outro: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
    },
  },
])
