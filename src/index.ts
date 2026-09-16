/**
 * dsh-data-migration host half.
 *
 * Exposes the local migration API the settings panel drives: native location
 * pickers, encrypted export, preflight, and confirmed restore. Every route is
 * loopback- and same-origin-fenced because it moves credentials and API keys,
 * and every mutating route is POST-only.
 *
 * @module dsh-data-migration
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exportMigration } from './migration/exporter.js'
import { applyMigration, preflightMigration } from './migration/importer.js'
import { resolveExportDestination, resolveImportSource } from './migration/paths.js'
import type { PreflightResult } from './migration/types.js'

export const name = 'dsh-data-migration'
export const inject = ['webServer']

/** Route prefix shared by the panel and this half. */
export const API_PREFIX = '/api/dsh-data-migration'

/** Request bodies here are tiny (paths and passwords). */
const MAX_BODY_BYTES = 16 * 1024

/** The picker stays open until the user decides; it never holds the data lock. */
const PICKER_TIMEOUT_MS = 120_000

/** One export/import at a time; a second request is refused with 409. */
let busy = false

/** Previews awaiting explicit confirmation, keyed by single-use operation id. */
const previews = new Map<string, PreflightResult>()

/** A native picker may not be opened twice concurrently. */
let pickerOpen = false

class BusyError extends Error {
  constructor() {
    super('Another migration operation is already running')
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

/** DSH home, honouring the same override every other DSH component reads. */
export function resolveTargetHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress?.toLowerCase()
  const host = request.headers.host?.toLowerCase() ?? ''
  const loopbackAddress =
    address === '::1' || address === '::ffff:127.0.0.1' || Boolean(address?.startsWith('127.'))
  const loopbackHost = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/.test(host)
  return loopbackAddress && loopbackHost
}

function sameOriginRequest(request: IncomingMessage): boolean {
  if (!isLoopbackRequest(request)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host.toLowerCase() === request.headers.host?.toLowerCase()
  } catch {
    return false
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function stringField(body: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = body?.[name]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Only the non-secret facts of a preview ever reach the browser. */
function redactPreview(preview: PreflightResult) {
  return {
    operationId: preview.operationId,
    createdAt: preview.manifest.createdAt,
    profiles: preview.manifest.meta.profiles,
    apiKeyEnvNames: preview.manifest.meta.apiKeyEnvNames,
    linkedDependencies: preview.manifest.meta.linkedDependencies ?? [],
    linkedSources: preview.manifest.meta.linkedSources ?? [],
    sensitiveCategories: preview.manifest.meta.sensitiveCategories,
    hasSensitiveData: preview.hasSensitiveData,
    fileCount: preview.manifest.files.length,
    totalBytes: preview.manifest.files.reduce((sum, file) => sum + file.size, 0),
  }
}

async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (busy) throw new BusyError()
  busy = true
  try {
    return await run()
  } finally {
    busy = false
  }
}

/** Escape a value for a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Pin PowerShell's redirected stdout to UTF-8.
 *
 * `powershell.exe` encodes stdout with the console code page — CP936 on this
 * 中文 Windows — so a chosen path arrives as GBK bytes. Measured on this host:
 * without this line `D:\code\提示词\dsh-safe-plugin` comes back as
 * `443a5c...cce1cabe...` (GBK), which decoded as UTF-16LE renders as the
 * mojibake `㩄捜摯履…`; with it the same path arrives as UTF-8 and round-trips
 * byte for byte. It must run before anything writes to stdout.
 */
export const PICKER_OUTPUT_PREAMBLE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'

/**
 * Build the PowerShell program that shows one native picker and prints the
 * chosen path. STA is explicit because `FolderBrowserDialog` requires a single
 * threaded apartment, and the path is written with `[Console]::Out.Write` so a
 * cancelled dialog prints nothing at all rather than an empty line.
 */
export function pickerScript(kind: 'directory' | 'file'): string {
  const dialog =
    kind === 'directory'
      ? [
          '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
          `$dlg.Description = ${psLiteral('选择 DSH 迁移包保存/读取的文件夹')}`,
          '$dlg.ShowNewFolderButton = $true',
        ]
      : [
          '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
          `$dlg.Title = ${psLiteral('选择 DSH 迁移包（.dsh-migrate）')}`,
          `$dlg.Filter = ${psLiteral('DSH 迁移包 (*.dsh-migrate)|*.dsh-migrate|所有文件 (*.*)|*.*')}`,
          '$dlg.CheckFileExists = $true',
        ]
  const selected = kind === 'directory' ? '$dlg.SelectedPath' : '$dlg.FileName'
  return [
    PICKER_OUTPUT_PREAMBLE,
    'Add-Type -AssemblyName System.Windows.Forms',
    ...dialog,
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    `  [Console]::Out.Write(${selected})`,
    '}',
  ].join('; ')
}

/**
 * Decode the picker's stdout into the chosen path.
 *
 * UTF-8 is the exact inverse of {@link PICKER_OUTPUT_PREAMBLE}, not a guess. A
 * BOM (should a host ever emit one) and the trailing newline are stripped.
 */
export function decodePickerOutput(buffer: Buffer): string {
  return buffer
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/[\r\n\u0000]+$/g, '')
}

/**
 * Show a native Windows picker and resolve with the chosen path, or
 * `undefined` when the user cancels. The dialog renders on the desktop session
 * of the DSH host process; a headless or service context returns no selection
 * (treated as cancel).
 */
export function pickWithPowerShell(
  kind: 'directory' | 'file',
  run: typeof spawn = spawn,
  timeoutMs = PICKER_TIMEOUT_MS,
): Promise<string | undefined> {
  const script = pickerScript(kind)
  return new Promise(resolvePromise => {
    const child = run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolvePromise(undefined)
    }, timeoutMs)
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(undefined)
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const value = decodePickerOutput(Buffer.concat(chunks))
      resolvePromise(value.length > 0 ? value : undefined)
    })
  })
}

/** Open one native picker, refusing a second dialog while the first is up. */
async function withPicker<T>(run: () => Promise<T>): Promise<T | undefined> {
  if (pickerOpen) throw new BusyError()
  pickerOpen = true
  try {
    return await run()
  } finally {
    pickerOpen = false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Operation failed'
}

export function apply(ctx: Context): void {
  const routes = [
    {
      kind: 'exact' as const,
      path: `${API_PREFIX}/pick-directory`,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST' || !sameOriginRequest(request)) {
          return writeJson(response, 403, { ok: false, code: 'forbidden' })
        }
        try {
          const path = await withPicker(() => pickWithPowerShell('directory'))
          writeJson(response, 200, { ok: true, path })
        } catch (error) {
          writeJson(response, 409, { ok: false, code: 'busy', message: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: `${API_PREFIX}/pick-file`,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST' || !sameOriginRequest(request)) {
          return writeJson(response, 403, { ok: false, code: 'forbidden' })
        }
        try {
          const path = await withPicker(() => pickWithPowerShell('file'))
          writeJson(response, 200, { ok: true, path })
        } catch (error) {
          writeJson(response, 409, { ok: false, code: 'busy', message: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: `${API_PREFIX}/export`,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST' || !sameOriginRequest(request)) {
          return writeJson(response, 403, { ok: false, code: 'forbidden' })
        }
        const body = await readJson(request)
        const password = stringField(body, 'password')
        const requested = stringField(body, 'destination')
        if (password === undefined || requested === undefined) {
          return writeJson(response, 400, { ok: false, code: 'invalid-request', message: '请填写保存位置和密码' })
        }
        try {
          const destination = resolveExportDestination(requested)
          const result = await exclusive(() =>
            exportMigration({
              home: resolveTargetHome(),
              destination,
              password,
              includeLinkedSources: body?.includeLinkedSources !== false,
            }),
          )
          writeJson(response, 200, {
            ok: true,
            outputPath: result.outputPath,
            size: result.size,
            sha256: result.sha256,
            profiles: result.manifest.meta.profiles,
            apiKeyEnvNames: result.manifest.meta.apiKeyEnvNames,
            linkedDependencies: result.manifest.meta.linkedDependencies ?? [],
            linkedSources: result.manifest.meta.linkedSources ?? [],
          })
        } catch (error) {
          if (error instanceof BusyError) {
            return writeJson(response, 409, { ok: false, code: 'busy', message: errorMessage(error) })
          }
          writeJson(response, 400, { ok: false, code: 'export-failed', message: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: `${API_PREFIX}/preflight`,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST' || !sameOriginRequest(request)) {
          return writeJson(response, 403, { ok: false, code: 'forbidden' })
        }
        const body = await readJson(request)
        const password = stringField(body, 'password')
        const requested = stringField(body, 'inputPath')
        if (password === undefined || requested === undefined) {
          return writeJson(response, 400, { ok: false, code: 'invalid-request', message: '请选择迁移包并填写密码' })
        }
        try {
          const inputPath = resolveImportSource(requested)
          const targetHome = resolveTargetHome()
          const preview = await exclusive(() => preflightMigration(inputPath, password, targetHome))
          previews.set(preview.operationId, preview)
          writeJson(response, 200, { ok: true, preview: redactPreview(preview) })
        } catch (error) {
          if (error instanceof BusyError) {
            return writeJson(response, 409, { ok: false, code: 'busy', message: errorMessage(error) })
          }
          writeJson(response, 400, { ok: false, code: 'preflight-failed', message: errorMessage(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: `${API_PREFIX}/apply`,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST' || !sameOriginRequest(request)) {
          return writeJson(response, 403, { ok: false, code: 'forbidden' })
        }
        const body = await readJson(request)
        const operationId = stringField(body, 'operationId')
        const confirmSensitive = body?.confirmSensitive === true
        const installDependencies = body?.installDependencies === true
        // Lifecycle scripts stay off unless the user opts in: they are the only
        // way a plugin can fetch a binary or build a native module, and the only
        // way restored data could run code during install.
        const allowScripts = body?.allowScripts === true
        const preview = operationId === undefined ? undefined : previews.get(operationId)
        if (preview === undefined || !confirmSensitive) {
          return writeJson(response, 400, { ok: false, code: 'invalid-confirmation', message: '请先预检并确认敏感数据声明' })
        }
        previews.delete(preview.operationId)
        try {
          const result = await exclusive(() =>
            applyMigration(preview, {
              confirmSensitive,
              installDependencies,
              allowScripts,
              materializeSources: body?.materializeSources !== false,
            }),
          )
          writeJson(response, 200, {
            ok: true,
            installs: result.installs,
            sources: result.sources,
          })
        } catch (error) {
          if (error instanceof BusyError) {
            return writeJson(response, 409, { ok: false, code: 'busy', message: errorMessage(error) })
          }
          writeJson(response, 400, { ok: false, code: 'apply-failed', message: errorMessage(error) })
        }
      },
    },
  ]
  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-data-migration: routes')
}
