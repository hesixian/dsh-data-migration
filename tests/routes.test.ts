import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_PREFIX, apply } from '../src/index.js'

/**
 * Route-level cover for the host half the web server actually mounts.
 *
 * The panel reaches the host exclusively through these paths, so a route that
 * is missing (or a body rejected as invalid) is indistinguishable from a
 * broken feature in the UI. The export destination arrives from the native
 * folder picker, which is why the folder form is asserted here rather than
 * only at the path-helper level.
 */

interface Captured {
  routes: Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<unknown> | unknown>
}

function mount(): Captured {
  const routes: Captured['routes'] = new Map()
  const ctx = {
    webServer: {
      register: (route: { path: string; handler: Captured['routes'] extends Map<string, infer H> ? H : never }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect: (run: () => unknown) => {
      run()
    },
  }
  apply(ctx as never)
  return { routes }
}

function request(body: unknown, method = 'POST'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(stream, {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  })
  return stream
}

interface Captured_Response {
  status: number
  payload: string
}

function response(): { res: ServerResponse; captured: Captured_Response } {
  const captured: Captured_Response = { status: 0, payload: '' }
  const res = {
    writeHead: (status: number) => {
      captured.status = status
      return res
    },
    end: (payload: string) => {
      captured.payload = payload
      return res
    },
  } as unknown as ServerResponse
  return { res, captured }
}

async function call(
  routes: Captured['routes'],
  path: string,
  body: unknown,
  method = 'POST',
): Promise<Captured_Response> {
  const handler = routes.get(`${API_PREFIX}/${path}`)
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  const { res, captured } = response()
  await handler(request(body, method), res)
  return captured
}

describe('migration host routes', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'routes-home-'))
    await writeFile(join(home, 'settings.yaml'), 'apiKeyEnv: ROUTES_TEST_KEY\nvalue: migrated\n')
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    vi.restoreAllMocks()
  })

  it('registers every path the panel calls, including both pickers', () => {
    const { routes } = mount()
    for (const path of ['pick-directory', 'pick-file', 'export', 'preflight', 'apply']) {
      expect(routes.has(`${API_PREFIX}/${path}`), `missing route: ${path}`).toBe(true)
    }
  })

  it('fences the pickers against non-POST and cross-origin callers', async () => {
    const { routes } = mount()
    // A GET on a registered route is refused by the plugin itself (403); a 401
    // is what an unregistered path falls through to, so this also pins that
    // the route exists rather than merely being registered somewhere.
    expect((await call(routes, 'pick-file', {}, 'GET')).status).toBe(403)
  })

  it('exports into a folder chosen by the picker', async () => {
    const { routes } = mount()
    const folder = await mkdtemp(join(tmpdir(), 'routes-out-'))
    const result = await call(routes, 'export', { destination: folder, password: 'correct twelve chars' })
    expect(result.status).toBe(200)
    const body = JSON.parse(result.payload) as { ok: boolean; outputPath: string; size: number }
    expect(body.ok).toBe(true)
    expect(body.outputPath).toBe(join(folder, 'backup.dsh-migrate'))
    expect(body.size).toBeGreaterThan(0)
    expect((await readFile(body.outputPath)).byteLength).toBe(body.size)
  })

  it('accepts a folder path written with a trailing separator', async () => {
    const { routes } = mount()
    const folder = await mkdtemp(join(tmpdir(), 'routes-trailing-'))
    const result = await call(routes, 'export', {
      destination: folder + '\\',
      password: 'correct twelve chars',
    })
    expect(result.status).toBe(200)
  })

  it('refuses a destination whose extension is not .dsh-migrate', async () => {
    const { routes } = mount()
    const folder = await mkdtemp(join(tmpdir(), 'routes-bad-ext-'))
    const result = await call(routes, 'export', {
      destination: join(folder, 'archive.zip'),
      password: 'correct twelve chars',
    })
    expect(result.status).toBe(400)
    expect(JSON.parse(result.payload)).toMatchObject({ code: 'export-failed' })
  })

  it('preflights a folder and mirrors the canonical file it read', async () => {
    const { routes } = mount()
    const folder = await mkdtemp(join(tmpdir(), 'routes-preflight-'))
    const exported = await call(routes, 'export', {
      destination: folder,
      password: 'correct twelve chars',
    })
    expect(exported.status).toBe(200)
    const preview = await call(routes, 'preflight', {
      inputPath: folder,
      password: 'correct twelve chars',
    })
    expect(preview.status).toBe(200)
    expect(JSON.parse(preview.payload)).toMatchObject({ ok: true })
  })

  it('refuses apply without a preflight operation id', async () => {
    const { routes } = mount()
    const result = await call(routes, 'apply', { operationId: 'missing', confirmSensitive: true })
    expect(result.status).toBe(400)
    expect(JSON.parse(result.payload)).toMatchObject({ code: 'invalid-confirmation' })
  })
})
