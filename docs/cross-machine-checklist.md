# 跨机迁移检查清单

从两台盘的机器（源机器，插件在 `D:\code\...`）迁移到**只有 C 盘**的机器时按顺序执行。
每一步给出**命令**和**期望输出**；不符就跳到文末排查表。

> 本清单对应**包含本次修复**的版本。若新机器用 `git clone` 取代码，源机器必须先把修复推送到 GitHub，
> 否则拿到的是没有「源码随包携带」「路径自动改道」「安装后校验」的旧版本。

## 这台新机器上会发生什么（先读这段）

源机器上 `profiles\web\package.json` 用**绝对路径**记着两个插件：

```
link:D:/code/dsh-data-migration
link:D:/code/提示词/dsh-safe-plugin
```

新机器没有 D 盘，这两条路径无法存在。**不处理的话，`pnpm install` 会退出 0 并留下断掉的软链，
然后 `dsh` 直接拒绝启动**（旧版本就是这样，面板还会显示绿色的「依赖已安装」）。

本次修复会：

1. 把插件源码随迁移包带过去（约 0.19 MB 压缩后）；
2. 检测到 `D:` 在本机不存在时，把源码改放到 `<DSH 主目录>\linked-plugins\<插件名>`；
3. 同步改写 `package.json`、`pnpm-lock.yaml` 里的 `link:` 声明（两处必须一致，否则 `--frozen-lockfile` 会拒绝）；
4. 把指向 `D:` 的 pnpm `storeDir` 删掉，改用 pnpm 默认存储位置。

所以**新机器上的插件路径不需要和源机器一致**，也不用你手工拷任何东西。

---

## 阶段 0：源机器（打包前）

| # | 操作 | 期望 |
| --- | --- | --- |
| 0.1 | `cd D:\code\dsh-data-migration; pnpm build` | 两个 `Build complete` |
| 0.2 | 重启 `dsh web`，打开 **设置 → DSH 数据迁移** | 面板能打开；「导出」区有**「把 profile 中 link: 依赖指向的插件源码一并打包」**（没有就是加载了旧构建） |
| 0.3 | `dsh --version` | 记下来，新机器要装同一版本（当前 `0.1.5-rc.1`） |

## 阶段 1：源机器（导出）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1.1 | 保存位置选文件夹（自动生成 `backup.dsh-migrate`），设置 ≥12 位密码 | —— |
| 1.2 | **保持「携带插件源码」勾选** | —— |
| 1.3 | 点「导出」 | 文件约 **0.92 MB**（不勾携带约 0.73 MB） |
| 1.4 | 记下界面显示的 SHA-256 | 用于传完后校验 |

## 阶段 2：把代码和迁移包送到新机器

本插件本身必须先在长新机器上跑起来才谈得上导入，所以先拿到源码。**放在哪个盘都行**，C 盘即可：

```powershell
git clone https://github.com/hesixian/dsh-data-migration C:\code\dsh-data-migration
```

（若走 GitHub 不便，也可把源机器的 `D:\code\dsh-data-migration` 整个目录拷到 `C:\code\dsh-data-migration`，
排除 `node_modules` 和 `.git`。）

迁移包单独用 U 盘传。**不要**走聊天软件或公共网盘。

## 阶段 3：新机器（装 DSH 和本插件）

顺序不能颠倒：**先让 dsh 自举出 `profiles\web`，再往里加插件**，最后才用面板导入。

| # | 命令 | 期望 |
| --- | --- | --- |
| 3.1 | `node --version` / `pnpm --version` | Node ≥ 20；没有 pnpm 就 `npm i -g pnpm` |
| 3.2 | `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` | 安装成功 |
| 3.3 | `dsh --version` | `0.1.5-rc.1`，**必须与源机器一致** |
| 3.4 | `dsh --profile web --dump-config > $null; echo $LASTEXITCODE` | **0**。这步会自举出 `%USERPROFILE%\.dsh\profiles\web\`（含 `package.json`/`cordis.yml`/`pnpm-workspace.yaml`），是下一步的前提 |
| 3.5 | `cd C:\code\dsh-data-migration; pnpm install; pnpm build` | 两个 `Build complete` |
| 3.6 | `dsh plugin --profile web add link:C:\code\dsh-data-migration` | pnpm 写入 `profiles\web\package.json` 并建软链 |
| 3.7 | `dsh --profile web --dump-config > $null; echo $LASTEXITCODE` | **0** |

> `dsh plugin --profile <名字> <参数…>` 只是把参数转发给该 profile 目录下的 pnpm。

> 3.7 是「本插件能在新机器上加载」的第一道独立判据，由 `dsh` 本体给出，不经过本插件。

> 之后启动一次 `dsh web`，**设置 → DSH 数据迁移** 面板出现，才能导入。

## 阶段 4：新机器（导入迁移包）

| # | 操作 | 期望 |
| --- | --- | --- |
| 4.1 | 打开 **设置 → DSH 数据迁移** | 面板正常 |
| 4.2 | 选迁移包（文件或所在文件夹），输入密码，点「预检」 | 4 个 profile、5 个 API Key 变量名、**162 个文件**（97 主体 + 65 携带源码） |
| 4.3 | **重点看黄色提示框** | 应出现「此迁移包记录的插件路径在**本机不存在**」并列出 2 条改道：`dsh-data-migration` 与 `dsh-safe-plugin`，从 `D:/code/...` 改到 `...\.dsh\linked-plugins\...`；另外列出 1 条被移除的 `storeDir`（`D:\code\dsh\.pnpm-store`） |
| 4.4 | 再确认「迁移包已携带以下插件源码」列出 2 条（43 / 22 个文件） | 若缺这条，说明迁移包是旧版导出的，需重新导出 |
| 4.5 | 勾选敏感数据确认；保留「恢复后自动安装 profile 依赖」与「重建这些插件源码目录」 | —— |
| 4.6 | **首次迁移建议勾选「允许 lifecycle scripts」** | `cloudflared` 需要下载二进制、`node-pty` 需要编译；不勾下方会列出被跳过的包 |
| 4.7 | 点「确认并恢复」 | 恢复完成；「插件源码写入结果」2 条·已写入，路径为 `<home>\linked-plugins\...` |
| 4.8 | 关闭 `dsh web`，重开 | 面板仍在 |

> 摘要里的「文件数」把携带的插件源码也算进去了（162 = 97 + 65），因为每份文件都要过哈希校验。

## 阶段 5：验收（关键）

在新机器上执行：

```powershell
# 5.1 profile 能被 dsh 本体解析（不经过本插件）——最重要的一条
dsh --profile web --dump-config > $null; echo "dump-config exit=$LASTEXITCODE"

# 5.2 插件源码确实落在了 DSH 主目录下
Get-ChildItem "$env:USERPROFILE\.dsh\linked-plugins" -Directory | Select-Object -ExpandProperty Name

# 5.3 link: 声明已改道，且不再含 D:
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\package.json" -Pattern 'link:'
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\pnpm-workspace.yaml" -Pattern 'storeDir'

# 5.4 软链没断
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-data-migration" -Force |
  Select-Object Name, LinkType, Target

# 5.5 cloudflared 二进制（4.6 勾了 scripts 时）
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\cloudflared\bin\cloudflared.exe"

# 5.6 凭据迁移到位
(Get-Item "$env:USERPROFILE\.dsh\.credentials.yaml").Length
```

| # | 期望 |
| --- | --- |
| 5.1 | `dump-config exit=0` |
| 5.2 | 列出 `dsh-data-migration` 与 `dsh-safe-plugin` |
| 5.3 | `link:` 指向 `...\.dsh\linked-plugins\...`；`storeDir` 无输出（已被移除） |
| 5.4 | `LinkType` 为 `SymbolicLink`/`Junction`，`Target` 指向 `linked-plugins` 下的真实目录 |
| 5.5 | `True`（勾了 scripts 时） |
| 5.6 | 约 559 字节 |

最后启动 `dsh web`，确认：面板在；随便发条消息模型能正常回复（说明 `settings.yaml` + `.credentials.yaml` 对上了）。

> **注意**：恢复后生效的是 `<home>\linked-plugins\dsh-data-migration` 这一份，不是阶段 2 的 `C:\code\dsh-data-migration`。
> 以后改插件源码要改**前者**并重新 `pnpm build`；`C:\code` 那份只用于首次导入，可以删掉。

---

## 已知限制

### `cc-tui` / `desktop` 会报 bundle 缺失 —— 真实问题，不是迁移的锅

`@deepseek-ai/dsh-switchblade@0.9.7` 同时满足：不在 dsh 自带包里、不在任何 `pnpm-lock.yaml` 里、
**npm registry 返回 404**，却以实体目录存在于源机器的 `profiles\cc-tui\node_modules\` 和 `desktop\`。
它既装不回来，也不是 `link:` 依赖（所以**不会**被随包携带），新机器上 `cc-tui` 会因
`cannot resolve profile bundle "@deepseek-ai/dsh-switchblade"` 起不来。

**`web` profile 不受影响**（bundles 里没有它，`cordis.patch.yml` 中相关片段是注释掉的）。
处理方式：今晚先只用 `web`；或手工把该目录从源机器拷到新机器的同一位置（`profiles\cc-tui\node_modules\` 下）。

### 其它

- `desktop` / `headless` 没有 `pnpm-lock.yaml`，会被跳过并在面板标为「缺少 lockfile」。预期行为。
- 恢复后面板不再提示「重启以载入环境变量」——环境变量只写入当前进程，重启反而会丢；需要持久化请自行 `setx`。
- 源机器上插件若停靠在 D 盘，`linked-plugins` 会落在 C 盘的 DSH 主目录里（即 `%USERPROFILE%\.dsh`），占用约 0.7 MB。

## 排查表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 预检摘要里没有「路径在本机不存在」改道提示 | 本机确实有 D 盘，或加载的是旧构建 | 有 D 盘则无需改道；否则 `pnpm build` 后重启 `dsh web` |
| 预检里 API Key 变量名只有 1 个 | 旧构建 | 同上；新版应显示 5 个 |
| 没有「已携带插件源码」 | 旧版导出的包，或导出时未勾选 | 源机器重新导出并勾选携带 |
| 恢复后 `dsh` 报 `cannot resolve profile bundle "dsh-data-migration"` | 源码没落地，或没勾「重建这些插件源码目录」 | 检查 `%USERPROFILE%\.dsh\linked-plugins`；重跑恢复 |
| 面板显示 `installed-with-broken-bundles` | 软链指向的目录不存在 | 看下方 brokenBundles 列表；对应插件需手工提供源码 |
| 面板显示 `install-failed` | pnpm 装不上（网络/registry） | 在 `%USERPROFILE%\.dsh\profiles\web` 手动跑 `pnpm install --frozen-lockfile` 看报错 |
| 面板显示 `spawn-failed` | 找不到 pnpm | `npm i -g pnpm`，确认在 PATH |
| `cloudflared` 功能报错 | 跳过了 lifecycle scripts | 在 `profiles\web` 下 `pnpm rebuild cloudflared` |
| `dump-config` 报 `cannot resolve profile bundle "@deepseek-ai/dsh-base"` | dsh 本体没装好 | 重装 `@deepseek-ai/dsh@0.1.5-rc.1` |

## 回滚

恢复过程中失败会**自动回滚**（含路径改道与源码写入）。恢复成功但结果不理想时：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\migration-snapshots" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

`migration-snapshots` 不会被迁移，也不会被扫描进迁移包。
