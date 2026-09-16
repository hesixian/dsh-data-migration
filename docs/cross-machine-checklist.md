# 跨机迁移检查清单

今晚在另一台机器上验证「迁移后插件能否完美加载」时按顺序执行。每一步都给出**命令**和**期望输出**；
任何一步和期望不符，直接跳到文末的排查表。

> 本清单对应的是**已包含本次修复**的版本。如果新机器是 `git clone` 拿到的代码，
> 旧机器必须先把修复推送到 GitHub，否则 clone 到的是没有「源码随包携带」和「安装后校验」的旧版本。

---

## 阶段 0：旧机器（打包前）

| # | 操作 | 期望 |
| --- | --- | --- |
| 0.1 | `cd D:\code\dsh-data-migration; pnpm build` | `✔ ...:host Build complete` + `✔ ...:client Build complete` |
| 0.2 | 重启 `dsh web`，打开 **设置 → DSH 数据迁移** | 面板能打开；「导出加密迁移包」下有**「把 profile 中 link: 依赖指向的插件源码一并打包」**这一勾选项（若没有，说明加载的是旧构建） |
| 0.3 | 记下旧机器上 DSH 的版本：`dsh --version` | `0.1.5-rc.1`（新机器必须装同一版本） |

## 阶段 1：旧机器（导出）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1.1 | 保存位置选一个文件夹（会自动生成 `backup.dsh-migrate`），设置 ≥12 位密码 | 密码框下方提示变为「密码不会保存到设置或日志中」 |
| 1.2 | **保持「把 link: 插件源码一并打包」勾选** | —— |
| 1.3 | 点「导出」 | 显示已写入路径、大小、SHA-256；文件大小约 **0.92 MB**（不勾携带约 0.73 MB，多出的约 0.19 MB 就是压缩后的插件源码） |
| 1.4 | 记录导出的 SHA-256 | 用于传输后校验完整性 |

## 阶段 2：把代码和迁移包送到新机器

两选一。

**A. 走 GitHub（需要先在旧机器推送修复）**

```powershell
git clone https://github.com/hesixian/dsh-data-migration D:\code\dsh-data-migration
```

**B. 不走 GitHub（今晚更省事）**

把 `D:\code\dsh-data-migration` 整个目录拷到新机器的**同一路径**，拷贝时排除 `node_modules` 和 `.git`。

迁移包单独传（USB 即可）。**不要**通过聊天软件或公共网盘传。

## 阶段 3：新机器（装 DSH 和本插件）

顺序不能颠倒：**先让 dsh 自举出 `profiles/web`，再往里加插件**，最后才用面板导入。

| # | 命令 | 期望 |
| --- | --- | --- |
| 3.1 | `node --version` / `pnpm --version` | Node ≥ 20；pnpm 可用（没有就 `npm i -g pnpm`） |
| 3.2 | `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` | 安装成功 |
| 3.3 | `dsh --version` | `0.1.5-rc.1`，**必须和旧机器一致** |
| 3.4 | `dsh --profile web --dump-config > $null; echo $LASTEXITCODE` | **0**。这一步会在 `%USERPROFILE%\.dsh\profiles\web\` 下自举出 `package.json` / `cordis.yml` / `pnpm-workspace.yaml`，是下一步的前提 |
| 3.5 | 按阶段 2 拿到插件源码后：`cd D:\code\dsh-data-migration; pnpm install; pnpm build` | 两个 `Build complete` |
| 3.6 | `dsh plugin --profile web add link:D:\code\dsh-data-migration` | pnpm 把它写进 `profiles\web\package.json` 并建立软链 |
| 3.7 | `dsh --profile web --dump-config > $null; echo $LASTEXITCODE` | **0** |

> `dsh plugin --profile <名字> <参数…>` 只是把参数转发给该 profile 目录下的 pnpm，
> 所以 `... add link:...` 等价于在 `profiles\web` 里 `pnpm add link:...`。

> 3.7 是「本插件能在新机器上加载」的第一道独立判据，由 `dsh` 本体给出，不经过本插件。
> 非 0 时看它打印的 `cannot resolve profile bundle "..."`，缺哪个补哪个。

> 此后启动一次 `dsh web`，**设置 → DSH 数据迁移** 面板就应该出现了。能打开面板才谈得上导入。

## 阶段 4：新机器（导入迁移包）

| # | 操作 | 期望 |
| --- | --- | --- |
| 4.1 | 启动 `dsh web`，打开 **设置 → DSH 数据迁移** | 面板正常 |
| 4.2 | 选择迁移包所在文件夹（或直接选 `.dsh-migrate`），输入密码，点「预检」 | 摘要显示 4 个 profile、5 个 API Key 变量名、**162 个文件**（97 个主体文件 + 65 个携带的插件源码文件） |
| 4.3 | 检查两个黄色提示框 | ① `link:` 依赖 2 条（`dsh-data-migration`、`dsh-safe-plugin`）②**「迁移包已携带以下插件源码」2 条**，分别 43 / 22 个文件 |
| 4.4 | 勾选敏感数据确认；保持「恢复后自动安装 profile 依赖」；**保持「重建这些插件源码目录」** | —— |
| 4.5 | 关于 lifecycle scripts：**首次迁移建议勾选**（cloudflared 需要下载二进制、node-pty 需要编译） | 不勾则下方会列出 4 个被跳过的包 |
| 4.6 | 点「确认并恢复」 | 恢复完成；下方显示「插件源码写入结果：2 条 · 已写入」 |
| 4.7 | 关闭 `dsh web`，重开 | 面板与插件都应在 |

> 恢复会覆盖 `profiles\web\package.json`、`pnpm-lock.yaml` 与 `pnpm-workspace.yaml` —— 这是有意的，
> 3.6 步写入的内容会被旧机器的版本取代，两者都含同一份 `link:` 声明，因此不会冲突。

> 4.3 里如果没有「已携带以下插件源码」这块，说明迁移包是旧版本导出的，或导出时没勾携带 —— 那就得手动把
> `D:\code\提示词\dsh-safe-plugin` 拷到新机器的同一路径。**这是旧版本最容易翻车的地方。**
>
> 摘要里的「文件数」把携带的插件源码也算进去了（162 = 97 + 65）。这是有意的：清单里每一份文件都要过哈希校验。

## 阶段 5：验收（关键）

在**新机器**上执行，全部通过才算「插件完美加载」：

```powershell
# 5.1 profile 能被 dsh 本体解析（不经过本插件）
dsh --profile web --dump-config > $null; echo "dump-config exit=$LASTEXITCODE"

# 5.2 两个 link: 插件确实落地了
Test-Path 'D:\code\dsh-data-migration\package.json'
Test-Path 'D:\code\提示词\dsh-safe-plugin\package.json'

# 5.3 依赖软链没有断
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-data-migration" -Force |
  Select-Object Name, LinkType, Target

# 5.4 cloudflared 二进制（若 4.5 勾了 scripts）
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\cloudflared\bin\cloudflared.exe"

# 5.5 凭据确实迁移过来了
(Get-Item "$env:USERPROFILE\.dsh\.credentials.yaml").Length
```

| # | 期望 |
| --- | --- |
| 5.1 | `exit=0` |
| 5.2 | 两个都 `True` |
| 5.3 | `LinkType` 为 `SymbolicLink`（或 `Junction`），`Target` 指向真实存在的目录 |
| 5.4 | `True`（勾了 scripts 时） |
| 5.5 | 约 559 字节 |

最后启动 `dsh web`，确认这三件事：

1. **设置 → DSH 数据迁移** 面板在；
2. 随便发一条消息，模型能正常回复（说明 `settings.yaml` + `.credentials.yaml` 都对上了）；
3. `settings.yaml` 里配置的其他插件面板（若有）都在。

---

## 已知限制（今晚会遇到）

### `cc-tui` 和 `desktop` 这两个 profile 会报 bundle 缺失 —— 这是真实问题，不是迁移的锅

`@deepseek-ai/dsh-switchblade@0.9.7` 同时满足：

- **不在** dsh 自带的包里；
- **不在** 任何 profile 的 `pnpm-lock.yaml` 里；
- **不在** npm registry 上（`pnpm view` 返回 404）；
- 却**以实体目录**存在于旧机器的 `profiles\cc-tui\node_modules\` 和 `profiles\desktop\node_modules\`。

所以它既装不回来、也拦不住：旧机器现在能用，纯粹因为那几个目录还在。新机器上 `cc-tui` 会因为
`cannot resolve profile bundle "@deepseek-ai/dsh-switchblade"` 起不来。

**`web` profile 不受影响**（`bundles` 里没有它，`cordis.patch.yml` 里相关片段是注释掉的）。

三种处理，任选：

1. **今晚先不管** —— 只用 `web`（本 GUI）。这是最省事的。
2. 手动把旧机器 `profiles\cc-tui\node_modules\@deepseek-ai\dsh-switchblade` 整个目录拷到新机器同一路径。
3. 从 `cc-tui` / `desktop` 的 `bundles` 里删掉 `@deepseek-ai/dsh-switchblade`（会少功能）。

### 其它

- `storeDir` 被硬编码为 `D:\code\dsh\.pnpm-store`（`pnpm-workspace.yaml` 和 `.npmrc` 各有一处）。
  新机器没有 `D:` 盘会失败；有 `D:` 盘则 pnpm 会自动创建该目录，只是会多占一份 store。
- `desktop` / `headless` profile 没有 `pnpm-lock.yaml`，恢复时会被跳过并在面板里标为「缺少 lockfile」。
  这是预期行为，不是错误。
- 首次恢复后面板提示已不再说「重启以载入环境变量」—— 环境变量只写入当前进程，重启反而会丢。
  需要在系统里持久化的话自行 `setx`。

---

## 排查表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板里没有「携带插件源码」勾选项 | 加载的是旧构建 | 旧机器 `pnpm build` 并重启 `dsh web` |
| 预检摘要里 API Key 变量名只有 1 个 | 旧构建（正则只认行尾） | 同上；新版本应显示 5 个 |
| 恢复后 `dsh` 报 `cannot resolve profile bundle "dsh-data-migration"` | 源码没随包携带，或没勾「重建这些插件源码目录」 | 手动把插件源码放到旧机器的原路径；或重新导出并勾选携带 |
| 面板显示「依赖已装但 bundle 解析失败」并列出 `dsh-data-migration` / `dsh-safe-plugin` | 软链指向的目录不存在 | 同上 |
| 面板显示 `install-failed` | pnpm 装不上（网络 / registry / store 路径） | 在 `%USERPROFILE%\.dsh\profiles\web` 下手动跑 `pnpm install --frozen-lockfile` 看报错 |
| 面板显示 `spawn-failed` | 找不到 pnpm | `npm i -g pnpm`，确认 `pnpm` 在 PATH |
| `cloudflared` 相关功能报错 | 跳过了 lifecycle scripts | 在 `profiles\web` 下 `pnpm rebuild cloudflared` |
| `dump-config` 报 `cannot resolve profile bundle "@deepseek-ai/dsh-base"` | dsh 本体没装好 | 重装 `@deepseek-ai/dsh@0.1.5-rc.1` |

## 回滚

恢复前本插件会为目标文件建立恢复点。若恢复过程中失败会**自动回滚**；
若恢复成功但结果不理想，手动方式：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\migration-snapshots" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

`migration-snapshots` 目录不会被迁移，也不会被扫描进迁移包。
