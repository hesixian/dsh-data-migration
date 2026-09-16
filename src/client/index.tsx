/**
 * dsh-data-migration browser half.
 *
 * Seats the “DSH 数据迁移” section in the settings shell. All file-system,
 * crypto, environment and installer work happens in the host half behind
 * loopback-fenced routes; this bundle only collects a location and a password,
 * renders the redacted preflight summary, and drives the confirmed restore.
 *
 * @module dsh-data-migration/client
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { classes, installStyles } from './styles.js'

/** Route prefix owned by the host half. */
const API = '/api/dsh-data-migration'

/** Section position: after the built-in sections, before plugin diagnostics. */
const SECTION_ORDER = 96

/** Minimum password length enforced by the exporter. */
const MIN_PASSWORD_LENGTH = 12

/** A profile dependency declared as `link:<path>` on the source machine. */
interface LinkedDependency {
  profile: string
  name: string
  spec: string
  target: string
}

/** A `link:` source the package carries, to be recreated at its original path. */
interface LinkedSource {
  profile: string
  name: string
  target: string
  fileCount: number
  bytes: number
}

/**
 * Paths that must move because the recorded location cannot exist here — a
 * profile exported on a machine with a second drive, restored onto one with a
 * single drive.
 */
interface RemapPlan {
  entries: { profile: string; name: string; from: string; to: string }[]
  storeDirs: { profile: string; value: string }[]
}

/** What happened to one carried source during a restore. */
interface SourceOutcome {
  name: string
  target: string
  status: 'created' | 'already-present' | 'failed'
}

const SOURCE_TEXT: Record<SourceOutcome['status'], string> = {
  created: '已写入',
  'already-present': '已存在，未覆盖',
  failed: '写入失败',
}

/** Redacted preflight summary; never carries secret values. */
interface Preview {
  operationId: string
  createdAt: string
  profiles: string[]
  apiKeyEnvNames: string[]
  linkedDependencies: LinkedDependency[]
  linkedSources: LinkedSource[]
  remap: RemapPlan
  sensitiveCategories: string[]
  hasSensitiveData: boolean
  fileCount: number
  totalBytes: number
}

interface InstallOutcome {
  profile: string
  ok: boolean
  status: string
  /** Bundles DSH still cannot resolve, so the profile will refuse to boot. */
  brokenBundles: string[]
  /**
   * Bundles that could not be resolved but may be supplied by the dsh
   * installation, so they are reported rather than treated as broken.
   */
  unverifiedBundles: string[]
  /** Packages whose build steps `--ignore-scripts` skipped. */
  skippedBuilds: string[]
}

const STATUS_TEXT: Record<string, string> = {
  installed: '依赖已安装',
  'installed-with-broken-bundles': '依赖已装但 bundle 解析失败',
  'install-failed': '安装失败',
  'spawn-failed': '无法启动 pnpm',
  'lockfile-missing': '缺少 lockfile',
  'package-missing': '缺少 package.json',
}

type Tone = 'idle' | 'ok' | 'error' | 'busy'

interface Status {
  tone: Tone
  text: string
}

const STATUS_CLASS: Record<Tone, string> = {
  idle: classes.status,
  busy: `${classes.status} ${classes.statusBusy}`,
  ok: `${classes.status} ${classes.statusOk}`,
  error: `${classes.status} ${classes.statusError}`,
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** POST JSON and unwrap the host envelope, surfacing the host's own message. */
async function post<T>(path: string, body: object): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
  } catch {
    return Promise.reject(new Error('无法连接 DSH 主机，请确认 dsh web 正在运行'))
  }
  const data = (await response.json().catch(() => undefined)) as
    | (Record<string, unknown> & { ok?: boolean; message?: unknown; code?: unknown })
    | undefined
  if (data === undefined) {
    return Promise.reject(
      new Error(`主机返回了非 JSON 响应（HTTP ${response.status}），请重启 dsh web 后重试`),
    )
  }
  if (!response.ok || data.ok !== true) {
    const message = typeof data.message === 'string' ? data.message : undefined
    const code = typeof data.code === 'string' ? data.code : `HTTP ${response.status}`
    return Promise.reject(new Error(message ?? code))
  }
  return data as T
}

/** One labelled location field with its picker buttons. */
function LocationField(props: {
  label: string
  hint: string
  placeholder: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  actions: { label: string; run: () => void }[]
}): ReactElement {
  return (
    <div className={classes.field}>
      <span className={classes.label}>{props.label}</span>
      <div className={classes.row}>
        <input
          className={`${classes.input} ${classes.grow}`}
          value={props.value}
          spellCheck={false}
          disabled={props.disabled}
          placeholder={props.placeholder}
          onChange={event => {
            props.onChange(event.currentTarget.value)
          }}
        />
        {props.actions.map(action => (
          <button
            key={action.label}
            type="button"
            className={classes.button}
            disabled={props.disabled}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
      </div>
      <span className={classes.cardHint}>{props.hint}</span>
    </div>
  )
}

/** The settings section content. */
export function DataMigrationPanel(): ReactElement {
  const [exportPath, setExportPath] = useState('')
  const [exportPassword, setExportPassword] = useState('')
  const [exported, setExported] = useState<{ outputPath: string; size: number; sha256: string }>()
  const [sourcePath, setSourcePath] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const [confirmed, setConfirmed] = useState(false)
  const [install, setInstall] = useState(true)
  const [carrySources, setCarrySources] = useState(true)
  const [materialize, setMaterialize] = useState(true)
  const [allowScripts, setAllowScripts] = useState(false)
  const [installs, setInstalls] = useState<InstallOutcome[]>()
  const [sources, setSources] = useState<SourceOutcome[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>({
    tone: 'idle',
    text: '迁移包等同于 DSH 身份备份，请只存放在可信的离线介质或你自建的加密存储中。',
  })

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setStatus({ tone: 'busy', text: `${label}…` })
    try {
      await action()
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : '操作失败' })
    } finally {
      setBusy(false)
    }
  }, [])

  const pickInto = useCallback(
    (route: 'pick-directory' | 'pick-file', apply: (path: string) => void): void => {
      void run('等待系统对话框', async () => {
        const result = await post<{ path?: string | null }>(`${API}/${route}`, {})
        if (typeof result.path === 'string' && result.path.length > 0) {
          apply(result.path)
          setStatus({ tone: 'idle', text: '已选择位置。' })
        } else {
          setStatus({ tone: 'idle', text: '已取消选择。' })
        }
      })
    },
    [run],
  )

  const passwordTooShort = exportPassword.length > 0 && exportPassword.length < MIN_PASSWORD_LENGTH

  const summaryChips = useMemo(() => {
    if (preview === undefined) return []
    const chips: { key: string; text: string; tone: string }[] = []
    for (const profile of preview.profiles) {
      chips.push({ key: `p-${profile}`, text: profile, tone: classes.chipBusiness })
    }
    for (const name of preview.apiKeyEnvNames) {
      chips.push({ key: `e-${name}`, text: name, tone: classes.chipWarn })
    }
    if (preview.profiles.length === 0) {
      chips.push({ key: 'p-none', text: '无 profile', tone: classes.chipNeutral })
    }
    if (preview.apiKeyEnvNames.length === 0) {
      chips.push({ key: 'e-none', text: '无 API Key 变量', tone: classes.chipNeutral })
    }
    return chips
  }, [preview])

  return (
    <section className={classes.root} data-dsh-plugin="dsh-data-migration">
      <div className={classes.header}>
        <span className={classes.title}>DSH 数据迁移</span>
        <span className={classes.subtitle}>
          加密导出 / 恢复 settings、profile 清单、skills、presets、storages 与凭据
        </span>
      </div>

      <div className={`${classes.callout} ${classes.calloutDanger}`}>
        迁移包包含 <strong>.credentials.yaml</strong> 与 settings.yaml 引用的 API Key，
        等同于 DSH 身份备份。请勿通过聊天软件、公共网盘或邮件转发。
      </div>

      <div className={classes.card}>
        <div className={classes.cardHead}>
          <span className={classes.cardTitle}>导出加密迁移包</span>
          <span className={classes.cardHint}>scrypt + AES-256-GCM</span>
        </div>
        <LocationField
          label="保存位置"
          hint="选择文件夹会自动生成 backup.dsh-migrate；也可直接填写完整 .dsh-migrate 文件路径。"
          placeholder={'例如 E:\\dsh-backup'}
          value={exportPath}
          disabled={busy}
          onChange={setExportPath}
          actions={[
            {
              label: '浏览文件夹…',
              run: () => {
                pickInto('pick-directory', setExportPath)
              },
            },
          ]}
        />
        <div className={classes.field}>
          <span className={classes.label}>迁移包密码</span>
          <input
            className={classes.input}
            type="password"
            value={exportPassword}
            disabled={busy}
            placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位高强度密码`}
            onChange={event => {
              setExportPassword(event.currentTarget.value)
            }}
          />
          <span className={classes.cardHint}>
            {passwordTooShort
              ? `还需 ${MIN_PASSWORD_LENGTH - exportPassword.length} 位`
              : '密码不会保存到设置或日志中，请自行记录。'}
          </span>
        </div>
        <label className={classes.check}>
          <input
            type="checkbox"
            checked={carrySources}
            disabled={busy}
            onChange={event => {
              setCarrySources(event.currentTarget.checked)
            }}
          />
          <span>
            把 profile 中 <code>link:</code> 依赖指向的插件源码一并打包（推荐；这些插件通常未发布到 npm，
            不带源码则新机器无法安装）
          </span>
        </label>
        <div className={classes.row}>
          <button
            type="button"
            className={`${classes.button} ${classes.primary}`}
            disabled={busy || exportPath.trim() === '' || exportPassword.length < MIN_PASSWORD_LENGTH}
            onClick={() => {
              void run('正在导出', async () => {
                const result = await post<{ outputPath: string; size: number; sha256: string }>(
                  `${API}/export`,
                  { destination: exportPath, password: exportPassword, includeLinkedSources: carrySources },
                )
                setExportPassword('')
                setExported(result)
                setStatus({ tone: 'ok', text: '导出完成，请安全保存该迁移包。' })
              })
            }}
          >
            {busy ? '处理中…' : '导出'}
          </button>
        </div>
        {exported !== undefined && (
          <div className={classes.result}>
            <span>
              已写入 <span className={classes.mono}>{exported.outputPath}</span>（
              {formatBytes(exported.size)}）
            </span>
            <span>
              SHA-256：<span className={classes.mono}>{exported.sha256}</span>
            </span>
          </div>
        )}
      </div>

      <div className={classes.card}>
        <div className={classes.cardHead}>
          <span className={classes.cardTitle}>导入迁移包</span>
          <span className={classes.cardHint}>预检不会修改本机配置</span>
        </div>
        <LocationField
          label="迁移包位置"
          hint="可以直接选择 .dsh-migrate 文件，也可以选择它所在的文件夹（将读取其中的 backup.dsh-migrate）。"
          placeholder={'例如 E:\\dsh-backup\\backup.dsh-migrate'}
          value={sourcePath}
          disabled={busy}
          onChange={setSourcePath}
          actions={[
            {
              label: '浏览文件…',
              run: () => {
                pickInto('pick-file', setSourcePath)
              },
            },
            {
              label: '浏览文件夹…',
              run: () => {
                pickInto('pick-directory', setSourcePath)
              },
            },
          ]}
        />
        <div className={classes.field}>
          <span className={classes.label}>迁移包密码</span>
          <input
            className={classes.input}
            type="password"
            value={importPassword}
            disabled={busy}
            placeholder="导出时设置的密码"
            onChange={event => {
              setImportPassword(event.currentTarget.value)
            }}
          />
        </div>
        <div className={classes.row}>
          <button
            type="button"
            className={`${classes.button} ${classes.primary}`}
            disabled={busy || sourcePath.trim() === '' || importPassword === ''}
            onClick={() => {
              void run('正在预检', async () => {
                const result = await post<{ preview: Preview }>(`${API}/preflight`, {
                  inputPath: sourcePath,
                  password: importPassword,
                })
                setImportPassword('')
                setPreview(result.preview)
                setInstalls(undefined)
                setConfirmed(false)
                setStatus({ tone: 'ok', text: '预检通过：尚未修改本机 DSH 配置。' })
              })
            }}
          >
            {busy ? '处理中…' : '预检'}
          </button>
        </div>

        {preview !== undefined && (
          <div className={classes.summary}>
            <div className={classes.summaryGrid}>
              <span className={classes.summaryTerm}>导出时间</span>
              <span className={classes.summaryValue}>{preview.createdAt}</span>
              <span className={classes.summaryTerm}>文件数</span>
              <span className={classes.summaryValue}>
                {preview.fileCount} 个（{formatBytes(preview.totalBytes)}）
              </span>
              <span className={classes.summaryTerm}>敏感内容</span>
              <span className={classes.summaryValue}>
                {preview.hasSensitiveData
                  ? preview.sensitiveCategories.join('、') || '包含凭据'
                  : '未检测到'}
              </span>
            </div>
            <div className={classes.chipRow}>
              {summaryChips.map(chip => (
                <span key={chip.key} className={`${classes.chip} ${chip.tone}`}>
                  {chip.text}
                </span>
              ))}
            </div>
            <label className={classes.check}>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={event => {
                  setConfirmed(event.currentTarget.checked)
                }}
              />
              <span>我确认此迁移包包含敏感凭据与 API Key，并了解恢复会覆盖本机同名配置</span>
            </label>
            <label className={classes.check}>
              <input
                type="checkbox"
                checked={install}
                disabled={busy}
                onChange={event => {
                  setInstall(event.currentTarget.checked)
                }}
              />
              <span>恢复后自动安装具备 lockfile 的 profile 依赖（禁用 lifecycle scripts）</span>
            </label>
            <label className={classes.check}>
              <input
                type="checkbox"
                checked={allowScripts}
                disabled={busy || !install}
                onChange={event => {
                  setAllowScripts(event.currentTarget.checked)
                }}
              />
              <span>
                安装时允许 lifecycle scripts（cloudflared 等需要下载二进制或编译原生模块；会执行第三方脚本）
              </span>
            </label>
            {preview.linkedDependencies.length > 0 && (
              <div className={`${classes.callout} ${classes.calloutWarn}`}>
                此迁移包引用了 <strong>{preview.linkedDependencies.length}</strong> 个指向源机器本地目录的
                <code>link:</code> 依赖。它们在目标机器上必须存在于相同路径，否则安装会「成功」但
                <code>dsh</code> 仍会拒绝启动：
                <ul className={classes.list}>
                  {preview.linkedDependencies.map(item => (
                    <li key={`${item.profile}-${item.name}`}>
                      <code>{item.name}</code>（{item.profile}）→ <code>{item.target}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.remap.entries.length > 0 && (
              <div className={`${classes.callout} ${classes.calloutWarn}`}>
                此迁移包记录的插件路径在<b>本机不存在</b>（通常是源机器有多个盘、本机没有）。
                若不改路径，安装会「成功」但 <code>dsh</code> 拒绝启动。恢复时会把这些插件改放到
                DSH 主目录下，并同步改写 <code>link:</code> 声明与 lockfile：
                <ul className={classes.list}>
                  {preview.remap.entries.map(item => (
                    <li key={`${item.profile}-${item.name}`}>
                      <code>{item.name}</code>：<code>{item.from}</code> → <code>{item.to}</code>
                    </li>
                  ))}
                </ul>
                {preview.remap.storeDirs.length > 0 && (
                  <>
                    以下 pnpm <code>storeDir</code> 指向不存在的盘，将被移除，改用 pnpm 默认存储位置：
                    <ul className={classes.list}>
                      {preview.remap.storeDirs.map(item => (
                        <li key={`${item.profile}-${item.value}`}>
                          <code>{item.value}</code>（{item.profile}）
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {preview.linkedSources.length > 0 && (
              <div className={`${classes.callout} ${classes.calloutWarn}`}>
                迁移包<b>已携带</b>以下插件源码，恢复时写到对应位置（若该目录已有内容则不会覆盖）：
                <ul className={classes.list}>
                  {preview.linkedSources.map(item => (
                    <li key={`${item.profile}-${item.name}`}>
                      <code>
                        {preview.remap.entries.find(entry => entry.name === item.name)?.to ?? item.target}
                      </code>
                      （{item.fileCount} 个文件，{formatBytes(item.bytes)}）
                    </li>
                  ))}
                </ul>
                <label className={classes.check}>
                  <input
                    type="checkbox"
                    checked={materialize}
                    disabled={busy}
                    onChange={event => {
                      setMaterialize(event.currentTarget.checked)
                    }}
                  />
                  <span>恢复时重建这些插件源码目录</span>
                </label>
              </div>
            )}
            {preview.linkedDependencies.length > preview.linkedSources.length && (
              <div className={`${classes.callout} ${classes.calloutDanger}`}>
                有 <strong>{preview.linkedDependencies.length - preview.linkedSources.length}</strong> 个
                <code>link:</code> 依赖没有随包携带（导出时未勾选，或源目录不存在）。
                请手动把它们放到上述路径，否则对应 profile 无法启动。
              </div>
            )}
            {preview.remap.entries.length > 0 && preview.linkedSources.length < preview.linkedDependencies.length && (
              <div className={`${classes.callout} ${classes.calloutDanger}`}>
                有依赖既没有随包携带、原路径在本机也不存在，无法自动修复 —— 必须手动提供源码。
              </div>
            )}
            <div className={classes.row}>
              <button
                type="button"
                className={`${classes.button} ${classes.danger}`}
                disabled={busy || !confirmed}
                onClick={() => {
                  void run('正在恢复', async () => {
                    const result = await post<{ installs: InstallOutcome[]; sources: SourceOutcome[] }>(
                      `${API}/apply`,
                      {
                        operationId: preview.operationId,
                        confirmSensitive: confirmed,
                        installDependencies: install,
                        allowScripts,
                        materializeSources: materialize,
                      },
                    )
                    setPreview(undefined)
                    setInstalls(result.installs)
                    setSources(result.sources ?? [])
                    const broken = result.installs.filter(item => item.brokenBundles.length > 0)
                    const rejected = (result.sources ?? []).filter(item => item.status !== 'created')
                    const notes: string[] = []
                    if (broken.length > 0) notes.push(`${broken.length} 个 profile 的 bundle 无法解析，dsh 将无法启动`)
                    if (rejected.length > 0) notes.push(`${rejected.length} 个插件源码未写入`)
                    setStatus(
                      notes.length === 0
                        ? { tone: 'ok', text: '恢复完成。' }
                        : { tone: 'error', text: `${notes.join('；')}；请查看下方结果。` },
                    )
                  })
                }}
              >
                {busy ? '处理中…' : '确认并恢复'}
              </button>
            </div>
          </div>
        )}

        {installs !== undefined && (
          <div className={classes.result}>
            <span className={classes.label}>插件依赖安装结果</span>            <div className={classes.chipRow}>
              {installs.length === 0 && (
                <span className={`${classes.chip} ${classes.chipNeutral}`}>未执行</span>
              )}
              {installs.map(item => (
                <span
                  key={item.profile}
                  className={`${classes.chip} ${item.ok ? classes.chipSuccess : classes.chipWarn}`}
                >
                  {item.profile} · {STATUS_TEXT[item.status] ?? item.status}
                </span>
              ))}
            </div>
            {installs.some(item => item.brokenBundles.length > 0) && (
              <div className={`${classes.callout} ${classes.calloutDanger}`}>
                以下 bundle 在安装后仍无法解析，<code>dsh</code> 会拒绝启动该 profile：
                <ul className={classes.list}>
                  {installs.flatMap(item =>
                    item.brokenBundles.map(bundle => (
                      <li key={`${item.profile}-${bundle}`}>
                        <code>{bundle}</code>（{item.profile}）
                      </li>
                    )),
                  )}
                </ul>
              </div>
            )}
            {installs.some(item => item.skippedBuilds.length > 0) && (
              <div className={`${classes.callout} ${classes.calloutWarn}`}>
                以下包已跳过构建脚本，可能缺少二进制或原生模块：
                <ul className={classes.list}>
                  {installs.flatMap(item =>
                    item.skippedBuilds.map(name => (
                      <li key={`${item.profile}-${name}`}>
                        <code>{name}</code>（{item.profile}）
                      </li>
                    )),
                  )}
                </ul>
                可在目标机器的 profile 目录手动执行 <code>pnpm rebuild</code> 补上。
              </div>
            )}
            {installs.some(item => item.unverifiedBundles.length > 0) && (
              <div className={classes.callout}>
                以下 bundle 未在 profile 中找到，但可能由 dsh 自带（如
                <code>@deepseek-ai/dsh-base</code>），因此未判定为错误。若 dsh 启动时报
                <code>cannot resolve profile bundle</code> 再处理：
                <ul className={classes.list}>
                  {installs.flatMap(item =>
                    item.unverifiedBundles.map(bundle => (
                      <li key={`${item.profile}-${bundle}`}>
                        <code>{bundle}</code>（{item.profile}）
                      </li>
                    )),
                  )}
                </ul>
              </div>
            )}
            {sources.length > 0 && (
              <div className={classes.result}>
                <span className={classes.label}>插件源码写入结果</span>
                <ul className={classes.list}>
                  {sources.map(item => (
                    <li key={item.target}>
                      <code>{item.target}</code> · {SOURCE_TEXT[item.status] ?? item.status}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <p role="status" className={STATUS_CLASS[status.tone]}>
        {status.text}
      </p>
    </section>
  )
}

/**
 * Client plugin body: install the stylesheet and seat the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(), 'dsh-data-migration: stylesheet')

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-data-migration',
        order: SECTION_ORDER,
        label: 'DSH 数据迁移',
      },
      DataMigrationPanel,
    ),
  )
}

export const inject = ['slots']

/** Re-exported so the panel can be rendered directly in tests. */
export type { Preview, InstallOutcome }
