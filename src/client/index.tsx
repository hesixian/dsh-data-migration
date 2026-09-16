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

/** Redacted preflight summary; never carries secret values. */
interface Preview {
  operationId: string
  createdAt: string
  profiles: string[]
  apiKeyEnvNames: string[]
  sensitiveCategories: string[]
  hasSensitiveData: boolean
  fileCount: number
  totalBytes: number
}

interface InstallOutcome {
  profile: string
  ok: boolean
  status: string
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
  const [installs, setInstalls] = useState<InstallOutcome[]>()
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
        <div className={classes.row}>
          <button
            type="button"
            className={`${classes.button} ${classes.primary}`}
            disabled={busy || exportPath.trim() === '' || exportPassword.length < MIN_PASSWORD_LENGTH}
            onClick={() => {
              void run('正在导出', async () => {
                const result = await post<{ outputPath: string; size: number; sha256: string }>(
                  `${API}/export`,
                  { destination: exportPath, password: exportPassword },
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
            <div className={classes.row}>
              <button
                type="button"
                className={`${classes.button} ${classes.danger}`}
                disabled={busy || !confirmed}
                onClick={() => {
                  void run('正在恢复', async () => {
                    const result = await post<{ installs: InstallOutcome[] }>(`${API}/apply`, {
                      operationId: preview.operationId,
                      confirmSensitive: confirmed,
                      installDependencies: install,
                    })
                    setPreview(undefined)
                    setInstalls(result.installs)
                    setStatus({
                      tone: 'ok',
                      text: '恢复完成，请重启 dsh web 或新开终端以载入新的环境变量。',
                    })
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
            <span className={classes.label}>插件依赖安装结果</span>
            <div className={classes.chipRow}>
              {installs.length === 0 && (
                <span className={`${classes.chip} ${classes.chipNeutral}`}>未执行</span>
              )}
              {installs.map(item => (
                <span
                  key={item.profile}
                  className={`${classes.chip} ${item.ok ? classes.chipSuccess : classes.chipWarn}`}
                >
                  {item.profile} · {item.status}
                </span>
              ))}
            </div>
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
