# DSH Data Migration

DSH Web 的本地数据迁移插件。它把 DSH 的配置、profile 插件清单、skills、presets、storages、插件私有数据、`.credentials.yaml`，以及 `settings.yaml` 引用的 API Key 环境变量，打进一个密码保护的 `.dsh-migrate` 文件；在新机器上先预检、再确认恢复。

> **高敏感操作**：迁移包等同于 DSH 身份备份。只应保存在可信的离线介质，或你自己控制的加密存储中；不要通过聊天软件、公共网盘或邮件转发。

## 功能

- **导出**：用系统文件夹对话框选择保存位置，自动生成 `backup.dsh-migrate`；也可以直接填写完整的 `.dsh-migrate` 文件路径。
- **导入**：既可以用文件对话框直接选择 `.dsh-migrate`，也可以选择它所在的文件夹（自动读取其中的 `backup.dsh-migrate`）。
- **预检**：解密、校验清单与哈希后才展示摘要（导出时间、profile、文件数、API Key 变量名、敏感类别、`link:` 依赖及其携带的源码）；预检阶段不修改本机任何配置。
- **确认恢复**：必须勾选敏感数据声明才会启用恢复按钮；恢复前为目标文件建立恢复点，写入或环境变量失败时自动回滚。
- **携带插件源码**：profile 里 `link:` 依赖指向的是**源机器上的绝对目录**，而这些插件几乎都没发布到 npm。导出时可把它们一并打进迁移包，恢复时写回原路径（目录已有内容则不覆盖）。不携带时面板会明确警告。
- **路径自动改道**：源机器若有多个盘而目标机器只有一个，`link:D:\...` 这类路径根本无法存在。预检会检测出记录路径所在盘不存在的情况，把它改放到 `<DSH 主目录>\linked-plugins\<插件名>`，并同步改写 `package.json` 与 `pnpm-lock.yaml` 里的 `link:` 声明（两处必须一致，否则 `--frozen-lockfile` 会拒绝），同时移除指向该盘的 pnpm `storeDir`。改道明细在预检摘要里逐条列出，不静默改路径。
- **依赖恢复与安装后校验**：仅对带有 `pnpm-lock.yaml` 的 profile 执行 `pnpm install --frozen-lockfile`。lifecycle scripts 默认禁用，可显式勾选放行（`cloudflared` 要下载二进制、`node-pty` 要编译原生模块）。
- **安装后校验**：`pnpm install` 对**不存在的 `link:` 目标也会退出 0**，只报告退出码等于报喜不报忧。因此安装后按 DSH 的解析顺序逐个探测 `dsh.profile.bundles`，把「已装但 bundle 解析不了」和「无法在本插件内验证」分开报告，并列出被跳过的构建脚本。

## 安全模型

- scrypt（`N=32768, r=8, p=1`）派生密钥，内容使用 AES-256-GCM 加密并认证；header 作为 AAD，篡改 KDF/nonce/版本字段会导致认证失败。
- 包内不迁移 `node_modules`、pnpm store、会话、附件或运行日志。
- 仅迁移 `settings.yaml` 中声明的安全 `apiKeyEnv` 环境变量；拒绝 `PATH`、`NODE_OPTIONS`、pnpm/npm 配置、代理及证书变量。
- 导入先预检：认证、严格文件白名单、哈希、路径、重复/大小写冲突、链接及解压容量限制全部通过后才允许应用。
- 所有接口仅限本机回环地址与同源请求（非回环、跨站 `Sec-Fetch-Site` 一律 403），写操作只接受 POST。
- 页面不显示凭据或 API Key 的值，也从不显示原始安装日志。
- 预检会把整个包（含 `.credentials.yaml`）解密到临时目录。该明文不会超过操作本身：恢复结束即删除，进程退出时删除本进程创建的，超过 30 分钟未恢复的残留由下一次预检清理。

## 安装

```powershell
cd D:\code\dsh-data-migration
pnpm install
pnpm build

# 把本地 bundle 加入 DSH Web profile
dsh plugin --profile web add link:D:\code\dsh-data-migration
```

然后重启 `dsh web`，打开 **设置 → DSH 数据迁移**。

> 插件的主机半（路由）在 `dsh web` 启动时装载，浏览器半在页面加载时装载。
> **改动源码后必须重新 `pnpm build` 并重启 `dsh web`**，否则页面会调用到尚未注册的路由。

## 使用

1. 旧机：选择保存文件夹（或填写完整 `.dsh-migrate` 路径），设置至少 12 位密码，点“导出”。
2. 把迁移包传到新机，并在新机安装本插件。
3. 新机：选择迁移包（文件或所在文件夹）并输入密码，点“预检”。这一步不会修改本机配置。
4. 阅读预检摘要，勾选敏感凭据确认，按需保留“自动安装 profile 依赖”。
   - 若摘要里出现 `link:` 依赖，确认“迁移包已携带以下插件源码”；没有携带的条目必须手工放到原路径。
   - 首次迁移到新机器时建议放行 lifecycle scripts，否则 `cloudflared` 等缺少二进制。
5. 点“确认并恢复”，完成后重启 `dsh web`。

完整的分步清单、期望输出和排查表见 **[docs/cross-machine-checklist.md](docs/cross-machine-checklist.md)**。

## 开发验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖：容器加解密与篡改检测、白名单扫描与清单校验、导入回滚、Windows 子进程启动形态、路径解析（文件夹 / 文件 / 尾分隔符）、以及主机路由端到端。

## 目录结构

```text
dsh-data-migration/
├─ src/
│  ├─ index.ts                 # 主机半：回环受限路由、原生选择器、导出/预检/恢复编排
│  ├─ client/
│  │  ├─ index.tsx             # 浏览器半：设置区面板
│  │  └─ styles.ts             # 基于 DSH 设计令牌的样式表
│  └─ migration/
│     ├─ paths.ts              # 导出目标 / 导入来源的路径解析
│     ├─ constants.ts          # 容器与白名单常量
│     ├─ scanner.ts            # 白名单扫描、API Key env 名发现
│     ├─ links.ts              # link: 依赖识别、DSH 顺序的 bundle 解析探测
│     ├─ sources.ts            # link: 源码随包携带与写回
│     ├─ remap.ts              # 盘符/根目录不可用时的路径改道与声明改写
│     ├─ manifest.ts           # 清单创建与校验
│     ├─ archive.ts            # tar.gz 创建与安全解包
│     ├─ crypto.ts             # scrypt / AES-GCM 容器
│     ├─ exporter.ts           # 导出编排
│     ├─ importer.ts           # 预检与恢复编排、解密暂存的生命周期
│     ├─ snapshot.ts           # 恢复点、原子替换、回滚
│     ├─ env.ts                # 用户环境变量读写
│     └─ installer.ts          # profile 依赖安装与安装后校验
├─ docs/
│  └─ cross-machine-checklist.md   # 跨机迁移检查清单
├─ tests/
├─ cordis.patch.yml
├─ tsdown.config.ts
└─ package.json
```

## 修复记录

本仓库由早期私有版本 `dsh-migration` 整理而来，主要修复：

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 页面“浏览…”按钮报错、导出提示 `Migration destination must use .dsh-migrate` | 浏览器半调用 `/api/dsh-migration/pick-directory`，但运行中的 `dsh web` 加载的是早于该路由的旧构建 | 统一路由前缀为 `/api/dsh-data-migration`，重建产物；并在 README 明确“改源码必须重新构建 + 重启” |
| 选择文件夹后仍必须手填 `.dsh-migrate` 才能导出 | 路径解析用 `resolve(value) !== value` 判断，尾部分隔符、`/`、`.` 段都被判为非法 | 新增 `src/migration/paths.ts`，改用 `isAbsolute` + `resolve` 归一化，并补 `tests/paths.test.ts` |
| 导入只能读取固定文件名 `backup.dsh-migrate` | 只有文件夹选择器，迁移包改名后无法导入 | 新增 `pick-file` 路由与“浏览文件…”按钮 |
| 自动安装依赖在 Windows 上总是 `spawn-failed` | `spawn('pnpm', …)` 无法直接执行 `.cmd` 垫片 | 新增 `spawnSpec()`，Windows 下经 `cmd.exe /d /s /c` 启动，并补 `PATHEXT` |
| UI 风格与当前页面不一致 | 内联样式硬编码颜色与圆角，缺少 hover/focus 状态 | 改为注入样式表，全部使用 `--dsw-alias-*` 设计令牌 |
| 客户端半与主机半容易脱节 | 仓库根目录手写 `client.js` 与 `src/client/index.ts` 各自维护，构建产物又是第三个文件 | `exports["./client"]` 直接指向构建产物 `lib/client.js`，删除手写副本 |
| 迁移到新机器后 `dsh` 拒绝启动，面板却显示绿色「依赖已安装」 | `pnpm install --frozen-lockfile` 对**不存在的 `link:` 目标也退出 0**，只把退出码当作成功判据，等于报喜不报忧 | 安装后按 DSH 的解析顺序（dsh 安装目录优先，再 profile）探测每个 `dsh.profile.bundles`；区分「确定为坏」与「本插件无法验证」，并把无法验证的项单独列出而不是判为错误 |
| `link:` 插件在新机器上无法获得 | 这些插件通常未发布（`dsh-safe-plugin` 没有 git 仓库也没有 npm 条目；`@deepseek-ai/dsh-switchblade` 是 workspace 包，npm 返回 404），而 `link:` 指向源机器的绝对路径 | 导出时可把 `link:` 指向的源码树打进迁移包，恢复时写回原路径（已有内容不覆盖，失败时回滚） |
| `cloudflared` 等在新机器上缺少二进制 | 一律带 `--ignore-scripts`，`cloudflared` 的 postinstall 下载、`node-pty` 的编译都被跳过 | 安装改为可选放行 lifecycle scripts，并在结果里列出被跳过的构建包 |
| 插件私有状态丢失 | 扫描范围只含配置与 profile，`skin-center/`、`task-board/`、`remote-web-ui-registry/`、`pet.json`、`dsh-usage/`、`dsh-session-archive/`、`data/` 都没进包 | 扩充到上述路径；同时排除 `.lock` / `.tmp` 残留文件（陈旧锁文件会卡住新机器上的插件） |
| 迁移摘要只列出 1 个 API Key 变量 | 发现正则要求 `apiKeyEnv` 出现在行首且值到行尾，而 `settings.yaml` 用 flow 风格写作 `{ apiKeyEnv: NAME, models: [...] }`，值后面是逗号 | 改为逐行扫描、允许行内任意位置，并校验值后面必须是分隔符，避免把注释和非法值算进来 |
| 预检解密出的明文凭据长期留在 `%TEMP%` | 暂存目录只在恢复成功时才删除；只预检不恢复（或操作过期）就永久残留 | 恢复结束即删除；进程退出时删除本进程创建的；超过 30 分钟未恢复的残留由下一次预检清理 |
| 迁到单盘机器后 `dsh` 拒绝启动 | 源机器插件在 `D:\...`，而 `link:` 记的是绝对路径；目标机没有 D 盘，路径无法存在，`pnpm install` 却仍退出 0 | 预检检测记录路径所在盘是否存在，不存在则把源码改放到 `<DSH 主目录>\linked-plugins\<插件名>`，并同步改写 `package.json` / `pnpm-lock.yaml` 的 `link:` 声明与 pnpm `storeDir`；改道明细在摘要中列明 |

## 许可证

[MIT](LICENSE)。
