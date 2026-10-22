<!-- 内嵌本体说明 -->
> ## 🏁 最后一个版本（v3.0.0），不再独立更新
>
> 本仓库停在 v3.0.0，**不再发布新版本、不再加新功能**。以后的一切更新都在 Tavern 本体里。

> ## ⚠️ 本插件已内嵌到 DSH Tavern 本体
>
> 从 **DSH Tavern 3.0** 起，剧情生图作为**内置插件**随本体一起安装与更新，**不再需要单独安装 dsh-tavern-image**。
>
> - **安装**：装好 Tavern 本体就有。设置里那一节叫「本地生图」。
> - **更新**：跟 Tavern 本体一起更新，不用管插件版本。
> - **反馈**：功能问题、bug、新需求请到 [flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern/issues) 提，本仓库不再作为主要反馈渠道。
> - **本仓库的用途**：保留源码与历史版本。旧版本仍可下载安装（给还在用 Tavern < 3.0 的人），但不会再独立发新功能。
>
> 本仓库的最后一个独立版本是 **v3.0.0**，内容与 Tavern 本体内置的一致。

# DSH Tavern Image

> 📖 **从旧版插件升级过来？** 看 [MIGRATION.md](MIGRATION.md)：怎么把角色库、世界书、渠道配置搬到新版。
>
> 💾 **换机 / 备份？** 面板里有「导出全部数据」和「导入全部数据」，一键打包六份数据成一个 JSON。

给 DSH Tavern 用的剧情配图插件。它读取已经完成的正文，挑选适合画成插图的场景，再交给你配置的生图服务生成，按剧情位置插回消息里。

可以用本地 ComfyUI、SD WebUI / Forge，也可以接 NovelAI、OpenAI Images、Gemini 等在线服务。人物资料、画风、提示词规则和图片记录在同一个面板里管理，适合给长篇角色扮演和故事配图。

## 插件的长处

- **图片跟着正文走。** 配图可以插在对应句子后面，并与这版正文绑定。切换回复版本时，显示的是对应版本的图，方便重写和回看剧情。
- **少画没有必要的图。** 智能选图允许规划模型跳过没有独立画面的回合。想给某轮补图时，手动生图仍然可用。
- **人物资料可以反复使用。** 外貌和服装集中维护，按当前卡片筛选角色；长篇中明确发生的永久外貌变化可以另存历史，减少前后提示词不一致。
- **写故事和画图可以用不同的模型。** 正文模型负责剧情，规划模型负责画什么、插在哪里、怎么写提示词，生图渠道负责出图。三者可以分别选择。
- **本地和在线服务都能用。** ComfyUI 可以直接选模型，也可以导入自己的工作流；换到在线渠道后，人物库、画风和正文配图流程仍可使用。

这些功能主要解决配图位置、资料维护和操作流程的问题。角色一致性和最终画质仍受生图模型、提示词、种子、LoRA 等因素影响，人物库不能保证每张图都完全一样。

## 安装与第一次出图

需要已经能使用的 DSH Tavern，以及本地生图服务或在线平台的 API 地址和密钥。

### Windows 安装

安装器默认使用 `%USERPROFILE%\.dsh` 下的 `tavern` Profile；可通过 `-Profile` 指定另一个**已经存在**的 Profile。安装器只安装插件源码，不运行仓库脚本；它调用 DSH 官方 CLI 的 `plugin add`，附带 `--ignore-scripts`，由 DSH 将 `dsh-tavern-image` 依赖、`node_modules` 链接和 bundle 一起登记。若目标目录或 Profile 中已有 canonical 注册，或 Profile 仍登记旧包名 `dsh-tavern-comfy`，安装器会停止，不覆盖已有内容或制造双重加载；更新已安装插件请用插件自己的更新页，旧注册迁移见下文。

已发布的离线安装包可从 [GitHub 发布页](https://github.com/weixinlll/dsh-tavern-image/releases)下载。解压后双击 `Install-DshTavernImage.cmd`，安装器直接使用包内源码，不必再从 GitHub 下载。发布页也提供独立源码包和 SHA-256 校验文件。请核对发布版本；需要最新的 2.5.3 修复时，可用下方的源码 ZIP 安装方式。

也可以在 GitHub 仓库页选择 **Code → Download ZIP**，解压后双击 `scripts\Install-DshTavernImage.cmd`（同目录有 `install-plugin.ps1`）。浏览器下载 [GitHub Archive ZIP](https://github.com/weixinlll/dsh-tavern-image/archive/refs/heads/master.zip) 或 [codeload ZIP](https://codeload.github.com/weixinlll/dsh-tavern-image/zip/refs/heads/master) 后，可以在 PowerShell 中指定文件：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-plugin.ps1" -SourceArchive "$env:USERPROFILE\Downloads\dsh-tavern-image-master.zip"
~~~

ZIP 顶层即使多套几层目录也能识别。

### 一键包 / 改版 DSH 的安装位置

有些一键包或改版把 DSH 数据放在别处，而且**根目录下面直接就是 `profiles` 文件夹**（没有 `.dsh` 这一层），例如 `D:\dsh\profiles\tavern`。安装器会自己找：

- 依次尝试：`-DshHome`（别名 `-Root`）→ 环境变量 `DSH_HOME` → `%USERPROFILE%\.dsh`、`%USERPROFILE%\dsh`、`%LOCALAPPDATA%\dsh`、`%APPDATA%\dsh` → 各固定磁盘根下的 `.dsh` / `dsh` / `DSH` / `dsh-tavern`
- 找不到时会把**找过的位置全部列出来**，并给出可直接复制的命令；安装开始时会打印最终选定的数据目录
- 手动指定时下面三种层级任选，都能自动识别成同一个数据目录：

~~~powershell
# 三种写法等价
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -DshHome "D:\dsh"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -Root "D:\dsh\profiles"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -Root "D:\dsh\profiles\tavern"
# 指定另一个已存在的 Profile
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -DshHome "D:\dsh" -Profile other
~~~

如果那个环境不用标准 DSH CLI 管理插件，加 `-NoRegister`：安装器只把源码放进 `profile-data\<profile>\data\tools\dsh-tavern-image`，不再调用官方 CLI，由你按该环境自己的方式启用（登记 link、加进插件清单等），然后完整重启 DSH。

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-plugin.ps1" -DshHome "D:\dsh" -NoRegister
~~~
安装器只复制插件包白名单，不复制 Git 历史、测试、`config.json`、`definitions.json`、世界书、缓存、任务记录或用户工作流。若已解压仓库，也可以传入 `-SourceDirectory`，安装器仍会逐个筛选允许的包文件。

有网络时，不带来源参数会先试官方 codeload，再试 GitHub Archive：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-plugin.ps1"
~~~

若下载失败，可先用浏览器下载 ZIP 再传入 `-SourceArchive`；也可以克隆源码到单独的临时目录并用 `-SourceDirectory` 安装：

~~~powershell
git clone https://github.com/weixinlll/dsh-tavern-image.git "$env:TEMP\dsh-tavern-image-source"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dsh-tavern-image-source\scripts\install-plugin.ps1" -SourceDirectory "$env:TEMP\dsh-tavern-image-source" -Profile tavern
~~~

运行 `scripts\Package-DshTavernImage.ps1` 可生成可离线携带的 ZIP；解压后双击其中的 `Install-DshTavernImage.cmd`。插件 **设置 → 配图 → 插件更新**页的“本机安装包”入口也可导出源码 ZIP，拷贝到目标电脑后用 `-SourceArchive` 安装。这个入口用于下载和转移安装包；当前 DSH Desktop 的插件清单页没有经验证的 GitHub URL/ZIP 安装输入框，不要在该页粘贴仓库网址。

安装器会显示插件版本和 ZIP 的 SHA-256，发布页也提供 `SHA256SUMS.txt`，下载后可以比对文件是否完整。安装后完整退出并重新打开 DSH Desktop，刷新网页不能替代宿主重启。

### 旧版目录迁移

已有旧包名 `dsh-tavern-comfy` 的安装不要再并排装一份。先完整退出 DSH（包括托盘进程）并备份整个插件目录。若旧目录仍叫 `dsh-tavern-comfy`，仅在确认 `tools` 下没有另一份 `dsh-tavern-image` 后改名为 `dsh-tavern-image`；不要覆盖或合并两个目录。Profile 的旧依赖由 DSH 官方 CLI 移除，不能手工编辑 bundle 列表：

~~~powershell
$plugin = Join-Path $env:USERPROFILE '.dsh\profile-data\tavern\data\tools\dsh-tavern-image'
$source = 'C:\path\to\dsh-tavern-image-candidate'
$backup = Join-Path $env:USERPROFILE 'dsh-tavern-image-backup-before-canonical-migration'
if (-not (Test-Path -LiteralPath $plugin -PathType Container)) { throw "找不到旧插件目录：$plugin" }
if (Test-Path -LiteralPath $backup) { throw "备份目录已存在，请先检查：$backup" }
if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json') -PathType Leaf)) { throw "候选源码目录无效：$source" }
Copy-Item -LiteralPath $plugin -Destination $backup -Recurse

$dshCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (Test-Path -LiteralPath $dshCli) {
  & $dshCli plugin --profile tavern remove dsh-tavern-comfy
} else {
  $dshCli = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (-not (Test-Path -LiteralPath $dshCli -PathType Leaf)) { throw '找不到 DSH 官方 CLI；请先定位正确的 CLI 路径。' }
  $env:PATH = "$env:USERPROFILE\.dsh\runtime;$env:PATH"
  node $dshCli plugin --profile tavern remove dsh-tavern-comfy
}
if ($LASTEXITCODE -ne 0) { throw 'DSH 官方 CLI 未能移除旧包登记；停止迁移并保留备份。' }

$codeFiles = @(
  'package.json', 'client.js', 'cordis.patch.yml', 'console.html', 'design-rules.md',
  'LICENSE', 'README.md', '世界书-通用生图规则.json', '世界书-角色与服装库.json',
  'scripts/install-plugin.ps1', 'scripts/Install-DshTavernImage.cmd', 'scripts/Package-DshTavernImage.ps1'
)
foreach ($file in $codeFiles) {
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $plugin $file) -Force
}
robocopy (Join-Path $source 'lib') (Join-Path $plugin 'lib') /E
if ($LASTEXITCODE -ge 8) { throw '复制插件代码失败；保留备份并停止迁移。' }

if ([IO.Path]::GetExtension($dshCli) -eq '.cmd') {
  & $dshCli plugin --profile tavern add "link:$($plugin.Replace('\', '/'))" --ignore-scripts
} else {
  node $dshCli plugin --profile tavern add "link:$($plugin.Replace('\', '/'))" --ignore-scripts
}
if ($LASTEXITCODE -ne 0) { throw 'DSH 官方 CLI 未能登记新包；保留备份并修复 CLI 后再继续。' }
~~~

把 `$source` 改成 2.9.1 候选仓库目录。上述复制只替换程序、两个只读 seed 和发行文件，保留原目录中的 `config.json`、`definitions.json`、`worldbook-outfits.json`、`workflows`、缓存及历史数据；整份备份在确认迁移成功前不要删除。若旧目录叫 `dsh-tavern-comfy`，先安全改名后再运行本步骤。其他 Profile 请把命令中的 `tavern` 改成对应名称。确认 CLI 成功后检查 Profile 只登记 `dsh-tavern-image`，再完整启动 DSH。安装器遇到旧登记时会停止并给出官方 `plugin remove` 指引；它不会替你编辑 Profile 或覆盖现有插件目录。若官方 CLI/pnpm 操作失败，保留备份并先修复官方包管理器，不要手改 bundle 或用裸 `pnpm add` 冒充完成注册。

**1.2.0 及更早版本**若通过 Git 安装，可先检查 `git status` 和分支、备份本地改动并退出 DSH，再把旧远端改到官方仓库并快进更新。出现本地改动或冲突时停止，不要强制覆盖。更新后按上面步骤改名并重新登记 link。配置、人物资料和历史记录留在原目录；若新旧目录都存在，先核实备份，不要合并或覆盖。

### 配置生图服务

打开 **设置 → 配图 → 生图规划**，选择提供商，填写地址、模型和鉴权信息并保存。

- **ComfyUI**：填写服务地址，默认是 `http://127.0.0.1:8188`。有鉴权时选择 Bearer 或 Basic，再测试连接。在同一处「渠道」里选择简单模式，或导入 API 格式工作流并设为默认。
- **在线平台**：新增渠道，填写平台提供的 API 根地址、模型名和 API Key。中转服务需要选择它实际支持的协议。
- **SD WebUI / Forge**：服务端需要开启 API，地址要能从运行 DSH 的设备访问。

“测试连接”不会提交生图任务。部分平台没有合适的只读探测接口，会显示“已配置”；这表示配置已填好，实际出图还需要确认模型权限、额度和服务端支持情况。

### 配置规划模型

在「配图规则」里选择规划模型。留空时跟随 Tavern 配置的后台模型，也可以单独指定渠道、模型和推理等级。

保存后，先用消息下方的「生图」按钮测试一轮，确认提示词、人物和图片位置是否合适，再使用每轮自动规划。使用参考图设计角色时，还需要配置支持视觉的看图模型。

## 自动配图与生成速度

后台配图由 **每轮自动规划配图（前台只写正文）** 控制。它在 Tavern 的轮次结算事件到达后启动，读取正文和可用的角色资料，生成图片计划，再把图片挂到对应句子后面。

开启 **智能决定是否配图** 后，“一轮几张”是图片数量上限，规划模型可以少画，也可以整轮跳过。例如只有简短对话、整理信息或过渡内容的回合，可以不生成图片。判断是否合适仍由规划模型完成，手动生图可以绕过自动跳过决定。

生成任务在后台运行，结算通知不需要等模型和图片全部完成。多张图各自完成后显示，较慢的一张不会挡住已经完成的图片。外部渠道默认同时生成 2 张，可以调整为 1–4 张；ComfyUI 的实际执行速度和顺序由它自己的队列决定。

智能选图先输出一次明确的配图决定和原因；需要记录角色变化时，先完成角色更新块。决定配图后，每张完整提示词通过校验就提交，模型继续规划后面的图片。第一张出图不需要等待整份规划结束。

规划决定不能在提交后撤回。后续输出出现矛盾或中断时，会停止尚未提交的图片并报告错误，保留已提交的任务。模型决定跳过时不会提交图片。重复提示词、缺少正文锚点或没有闭合的画面块也不会提交。

多张图按重要性输出，用不同景别、动作或叙事用途表现正文；人物外貌、服装和地点跟随各画面对应的剧情时点。具体构图由模型决定，插件会拦截提示词完全相同的重复任务。

当前 Tavern 的公开事件是在轮次结算后触发。插件能减少规划和出图之间的等待，但不能把启动时机提前到正文生成中，也不会加速 Tavern 本身的结算。

正文下方的「生图」按钮可能比结算事件更早出现。此时手动点击会等待官方正文接口可读；如果后台自动配图也已开启，这次等待会合并到同一份任务，避免重复提交。按钮出现并不代表后台已提供正文数据，插件目前没有实现按钮出现时自动点击。

同一版正文的自动处理会复用已有计划，避免重复事件再次收费。更换渠道或世界书规则会用于后续新轮次；需要重新处理当前轮时，使用手动生图。

### 自动规划和正文标记有什么区别

插件还保留了另一种方式：让前台模型在正文里输出 `image###提示词###` 标记，再按标记生成图片。

| 方式 | 控制项 | 用途 |
|---|---|---|
| 后台规划 | 每轮自动规划配图 | 正文完成后，另一次模型调用负责选场景、位置和提示词 |
| 正文标记 | 自动生图 / 生图数量 | 前台模型在正文中写出生图标记；使用时需关闭智能选图并开启自动生图 |
| 手动生成 | 消息下方的生图按钮 | 指定某轮重新规划配图，不受自动规划开关和自动跳过限制 |

后台规划默认开启，正文标记默认关闭。只想手动生图时，可以关闭后台自动规划；若也不需要自动记录角色外貌历史，可以同时关闭角色自动更新，避免结算后继续调用规划模型记录外貌。

## 生图渠道

| 提供商 | 接入方式 |
|---|---|
| ComfyUI | API 工作流或简单模式，支持 Bearer / Basic 鉴权 |
| NovelAI / 同协议第三方 | NovelAI 生图协议 |
| OpenAI / Images 兼容中转 | Images 接口，可处理 Base64 和图片 URL 返回 |
| Google Gemini 原生 | 原生 `generateContent` 图片响应 |
| Banana / Gemini 聊天兼容中转 | `chat/completions` 中的图片内容或链接 |
| Grok Images | xAI 图片接口 |
| Seedream / 火山方舟 | Ark 图片接口 |
| 百炼 Qwen-Image | DashScope 图片接口 |
| SD WebUI / Forge | `sdapi/v1/txt2img` |

同一个提供商可以配置多条渠道，分别保存名称、地址、模型和鉴权。可以在自己的服务和不同中转之间切换，无需把原配置删掉再重新填写。复制渠道后，需要给副本填写自己的密钥。

这里接的是平台 API，网页登录账号不能代替 API Key。第三方服务只有在兼容相应协议时才能使用；单有网址和密钥，并不代表所有平台都能接入。

渠道密钥在设置界面中不回显。留空保存会保留原密钥，明确清除后再保存才会删除。下载服务返回的图片链接时，不会把 API Key 发送给图片服务器。

生图请求遇到网络错误时不会自动重发。如果服务端已接收任务但响应丢失，先查看任务记录，再决定是否手动重试，避免重复创建付费任务。

## 人物库与角色设计

人物库用来保存角色的稳定外貌和服装。规划模型知道正文中出现了谁，插件再把对应资料补到绘图提示词里；同一个人物不用每轮从零写描述。

外貌按角色特征、正背面、上下半身及常规 / 裸露版本分块保存。出图时根据视角和画面选择可见部分，减少近景里塞进全身细节、背面图仍强调正脸等冲突。服装可以保存多套，也可以使用通用服装资料。

角色较多时，界面用搜索和下拉框选择当前角色，一次只展开一个编辑区。支持按中文名和触发名筛选、收起编辑、复制角色，以及批量修改外貌字段、说明、启用状态和卡片绑定。

批量修改会先留在编辑区，检查后点击 **保存人物库**。切换角色会保留当前编辑草稿；后台刷新和异步设计返回时，会尽量保留期间的手动修改。复制角色会生成独立编号，修改副本不会改动原角色。

角色可以绑定卡片，未绑定的角色可供所有卡片使用。不同故事里有同名角色时，绑定卡片有助于减少误用资料。

设计角色可以使用文字需求、当前卡片上下文或参考图，也能让模型改进已有角色。参考图需要看图模型支持视觉；识别结果仍需检查，尤其是服装、发色、背面等图中看不清的部分。

## 角色随剧情变化与历史

人物库保存你维护的基础设定，角色历史保存某条剧情线中发生的外貌变化。两份数据分开，剧情更新不会直接改写全局人物库。

例如正文明确写出角色永久留疤、剪短头发或失明，插件可以为人物库里已知的角色记录这次变化，并在后续配图中使用。衣着、姿势和临时状态不会作为永久外貌变化写入。

历史按剧情线、轮次和正文版本保存。回退或切换正文版本时，插件读取宿主提供的对应快照；在「角色历史」面板可以查看变化，并把某个字段恢复到变化前。恢复会写入一条新的记录，不会把已有记录直接删掉。

这项功能需要 **Tavern 插件接口 v2**。接口 v1 下角色历史不可用，其他配图功能仍按宿主可用接口工作。历史记录有容量上限，异常或不完整输出会提示并沿用已有快照，不能当作无限容量的剧情档案。

## 提示词与画风预设

设置页的「画风」一节提供画风预设和提示词预设：

- **画风预设**保存画师串、固定风格词和负面词，可以调整放在提示词前面还是后面。
- **提示词预设**给规划和出图提供构图、光线、材质、色彩与画面重点的指导。内置杂志人像、电影叙事、动漫角色、东方幻想和氛围场景，也可以自己新增。

提示词表达可选择自动、标签、自然语言或混合模式。自动模式会按生图渠道和 ComfyUI 模板选择表达方式：例如 NovelAI 更适合标签，OpenAI Images、Gemini 等渠道使用自然语言描述。

预设在现有规划调用中使用，不会为应用预设再额外调用一次模型。正面指导和负面约束分开保存，切换渠道时也可以继续使用自己整理的风格资料。

想保持一个故事的整体画风，可以固定一套预设；要改变某张图的镜头或气氛，则在这张图的提示词里单独修改。

## ComfyUI 简单模式

简单模式适合已经装好模型、希望直接选模型和参数出图的情况。进入 **画风 → ComfyUI 生成方式**，选择简单模式，刷新模型列表，再选择模板和模型并保存。

| 模板 | 需要的模型与组件 |
|---|---|
| Checkpoint | SD / SDXL Checkpoint，可使用内置或外置 VAE |
| Flux | Flux UNet、T5-XXL 与 CLIP-L 编码器、对应 VAE |
| Anima | 可识别的 Anima 扩散模型、Qwen-3 编码器、对应 VAE |

可设置尺寸、步数、采样器、调度器、种子和模板支持的 LoRA。空种子按张随机，填写种子则使用固定值。

模型、节点和参数选项来自当前 ComfyUI 的 `/object_info`。缺少对应节点或模型时，模板会提示不可用；刷新列表不会提交生成任务。

简单模式只内置这三类模板。需要自定义节点、特殊采样流程或额外节点包时，使用工作流模式。

## 工作流导入与可视化编辑

工作流模式适合继续使用你在 ComfyUI 中调好的流程。导入的必须是 **API 格式 JSON**，普通的画布工作流 JSON 不能直接作为生成请求使用。

插件会识别正负提示词、尺寸、采样参数、底模和 LoRA 等绑定。可以保存多份工作流，设定默认流程，按不同画风切换；识别不符合预期时，可以在编辑区调整绑定。

可视化编辑支持查看节点和连线、缩放和平移、拖动节点，在右侧修改已有节点的文字、数字和开关输入。保存时会备份旧文件，并保存节点位置；同一文件已被其他操作修改时，会提示重新打开，避免覆盖。

连线是只读的，增删节点或重新连线仍需在 ComfyUI 中完成后重新导入。自动绑定的提示词、随机种子和尺寸等输入，在出图时会由当前生成设置替换。

工作流库的试跑使用所选工作流，即使当前选的是简单模式或在线渠道，也不会把试跑请求发给另一个渠道。

## 查看图片与重画

| 操作 | 效果 |
|---|---|
| 点击图片 | 在 DSH 内打开大图查看器 |
| 右键或长按图片 | 打开提示词和重画操作 |
| 查看器左右按钮或方向键 | 在图片之间翻页 |
| 滚轮、拖动 | 缩放和平移查看细节 |
| 编辑正负提示词后重画 | 新图成功后在原位置替换，旧图文件留在历史图中 |
| 取消这张图 | 停止等待指定任务，其他图片继续生成 |
| 重试这张图 | 只重试已确认失败的一张，不重新规划整轮 |
| 重画时选择渠道 | 这次使用所选渠道，不改全局生图设置 |
| 历史图面板 | 查看图片记录、打开大图或批量删除 |

也可以让后台模型按要求改写这张图的提示词，再用修改结果重画。图片概括由 Tavern 显示一处，插件保留替代文本，避免正文下重复出现同一说明。

正文中的单张重画通过 Tavern 的媒体接口更新原位置。新图成功前保留旧图，失败只显示该任务的错误；任务记录保存在服务端。历史图查看器的重画版本链仍保存在当前浏览器中，清理浏览器数据或换设备后不会自动同步。

再次点击某轮的「生图」会重新规划并替换这轮原来的配图。新图全部成功时清理旧配图；部分失败时保留没有被成功替换的旧图。历史图片文件仍留在历史图中。

每张图分别显示排队、生成、完成、失败或状态待确认。取消已提交任务只能停止本地等待，平台仍可能继续生成；插件不会为了取消一张图去中断 ComfyUI 的整个队列。请求超时或响应丢失时不自动重发。已知的 ComfyUI、百炼异步任务会查询原编号；查不到可靠结果时，请先到平台确认用量和任务。

## 世界书与图片格式

「世界书」页管理发给规划模型的配图规则，例如场景选择、镜头、角色资料使用和输出格式。可以导入世界书 JSON，也可以粘贴 JSON 或纯文本，逐条编辑和启用；未启用的条目不会进入配图规则。

每条规则可以选择常驻或关键词触发，并限制适用的生图渠道。常驻规则每轮携带；关键词规则只在本轮正文命中任一关键词时携带。没有填写关键词的触发条目不会注入。渠道全部不勾选时适用所有渠道，旧条目默认保留常驻行为。

人物的详细资料优先提供给本轮正文提到的角色，其他人物只留姓名索引。没有可靠匹配到姓名时会回退到全部可用角色，避免只用代词的正文遗漏人物。世界书页可以展开上次规划的条目、纳入或排除原因、角色和输入字符统计。

固定规则、输出协议和画风要求放在请求前部，动态条目、人物资料和本轮任务放在后部，方便支持上下文缓存的平台复用固定内容。请求仍通过 DSH 的模型接口发送；是否命中缓存取决于平台，字符统计不代表 token 数或实际费用，也不是模型的永久记忆。

导出会先尝试复制 JSON；剪贴板不可用时改为下载文件，并保留可手动复制的文本。

### 分角色提示词（NovelAI）

NovelAI 官方格式渠道支持把每个角色写成独立的 char caption，而不是全部塞进一条 base 提示词。这套格式由**世界书**提供：种子世界书里有一条「11 分角色提示词（NovelAI）」，只对 NovelAI 渠道生效，其它渠道和对话格式（`chat/completions` 中转）不会看到它。插件不会自动改你的世界书；已经初始化过世界书的老用户不会随升级拿到新条目，需要手动加一条（内容见仓库里的 `世界书-通用生图规则.txt`，或直接导入整份种子规则）。

在 `<prompts>` 里的结构是：

```xml
<prompts>
<scene_composition>1girl, solo, indoors, upper body, from front</scene_composition>
<character_1>
<prompt>lin lan, black hair, white shirt, opening door, looking back</prompt>
<centers>C3</centers>
<uc>background characters</uc>
</character_1>
</prompts>
```

- `<scene_composition>` 只放场景、背景、光影、构图和人数 Tag；角色一律进各自的 `<character_N>`（N 从 1 连续编号，最多 8 个）
- 每个角色的 `<prompt>` 写这个人的外貌、服装、姿势、动作、表情和互动；人物库里的角色可以用人物宏（`${"name":"…"}$`），插件会按宏补全外貌与服装，库外角色直接白描
- `<centers>` 可选，用 5×5 网格：列 `A`–`E`（左→右）、行 `1`–`5`（上→下），`C3` 表示正中，映射到归一化坐标 0.1–0.9。**只要有一个角色没写坐标就整张不用坐标**（避免没坐标的角色被甩到角落），改用 NAI 自动布局
- `<uc>` 是这个角色单独的负面词，写进 `v4_negative_prompt`，不影响其他角色
- 标签要成对闭合；Tag 内不要出现 `<` `>`，否则会截断结构
- 长按图片打开的提示词编辑器会把场景和角色块一起显示，改完重画仍按角色分区发送；「重画」和「单图重绘」都会沿用原图的角色块
- 没有 `<character_N>` 时仍按原来的一条提示词处理；其它渠道（ComfyUI、OpenAI、Gemini、SD WebUI、Qwen）即使收到结构，也会把场景与角色用逗号合并回一条提示词

默认配图规则用于首次初始化，已保存的个人规则不会随插件升级重置。导入的其他引擎宏和包装语法会做清理；只导入适合绘图规划的内容更容易检查结果。

需要减少图片体积时，可以开启 **PNG 转 JPEG**，质量可设为 50–100。透明区域会按所选背景色铺底。已经是 JPEG 或其他格式的图片不会重复转换；转换失败或超过限制时保留原图并给出说明。默认保持原始格式。

## 数据、更新与 DSH 接口

插件使用 Tavern 的公开接口处理轮次通知、正文附件、图片显示和消息动作，不需要修改 Tavern 的源码。宿主升级不会覆盖一份额外的源码补丁；如果公开接口本身发生不兼容变化，插件仍需要适配。

图片随正文版本显示，自动规划也会检查版本是否仍有效；正文改写或删除后，不会继续把旧任务的结果挂到新正文上。

主要本地数据如下，均在插件文件夹内：

| 文件或目录 | 内容 |
|---|---|
| `config.json` | 渠道、模型和插件设置（API Key 和鉴权密码存在 DSH 凭据服务里，见[凭据存储](docs/release-and-platform.md#凭据存储)） |
| `definitions.json` | 人物、服装、场景和物件资料 |
| `worldbook.json` | 自己维护的配图规则 |
| `jobs-store.json`、`plans-store.json` | 图片作业与规划记录 |
| `cache/`、`backups/` | 图片缓存与文件备份 |
| `workflows/*.json` | 自己导入的工作流 |

这些运行数据由 `.gitignore` 排除，不随正常 Git 提交上传。备份或迁移时保留整个插件文件夹；分享规则时可使用世界书导出，分享工作流前也要检查文件内容。

提示词和生图请求会发送给所选服务，参考图识别也会发送给看图模型。后台规划（包括开启的角色历史更新）和生图服务均可能产生费用，具体额度与数据处理方式以你的服务商说明为准。

在设置页底部的「插件版本与更新」里先检查，再安装已检查到的版本。自动更新要求官方 Git 安装、`master` 分支和无本地代码改动；提交分叉、目录冲突或远端改动涉及用户数据路径时会停止。下载源码安装的副本需要手动更新。更新后完整重启 DSH。

## 常见问题

| 情况 | 先检查什么 |
|---|---|
| 自动配图没有生成图片 | 自动规划是否开启；智能选图是否决定跳过；规划模型与生图渠道是否可用 |
| 手动生图也失败 | 查看任务错误；确认 API 地址、鉴权、模型权限，或 ComfyUI 工作流 / 简单模式配置 |
| 图片插在正文末尾 | 规划模型选出的挂载句是否逐字存在于正文；锚点匹配失败会回退到末尾 |
| ComfyUI 连不上 | 运行 DSH 的设备是否能访问这个地址；端口和鉴权是否正确 |
| 简单模式找不到模型 | 刷新模型列表，检查 ComfyUI 中对应模型、编码器、VAE 和节点是否齐全 |
| 同一角色外貌不稳定 | 检查人物名称、触发名、卡片绑定和外貌资料；生图模型自身也会影响一致性 |
| 角色历史不可用或没有新记录 | 当前 Tavern 是否提供插件接口 v2，以及角色自动更新是否开启 |
| 在线渠道显示“已配置”，但出图失败 | 这不是成功出图结果；检查额度、模型名和中转服务的协议支持 |
| 更新按钮不可用 | 检查是否 Git 安装、是否在 master、有无代码修改或重复目录 |

只想少画几张，可以降低数量上限、开启智能选图，或改用手动生成。出图速度主要取决于模型、分辨率、显卡和远端队列，插件不会为了提速绕过服务端的执行规则。

## 兼容与许可

当前本地体验候选为 **2.9.1**（未发布）。插件清单声明的 DSH 兼容范围为 `>=0.1.0-rc.8 <0.3.0`，覆盖 DSH 0.1.5 与 0.2.x（含 DeepSeek Harness 0.2.1-rc.2 / Tavern 3.0）；角色历史另外需要 Tavern 插件接口 v2。

在 DSH 0.2.1-rc.2 + Tavern 3.0.0 上核对过：插件 bundle 正常加载（宿主加载器返回 0 个被跳过的包），本插件调用的 14 个 Tavern 接口（`attach`、`update`、`remove`、`list`、`getTurn`、`readTurnData`、`saveTurnData`、`promptSection`、`onTurnSettled`、`onGameRemoved`、`onTimelineChanged`、`getCardContext`、`backgroundModel`、`apiVersion`）在 Tavern 3.0 中全部保留，3.0 相对 2.7 的接口变化是纯新增（例如 `versionSignal`）。

新包名、浏览器模块加载键、bundle 名称和插件 ID 统一为 `dsh-tavern-image`。旧包名 `dsh-tavern-comfy` 仅用于兼容读取和迁移现有 Profile 注册。

界面与功能设计参考了 [st-chatu8](https://github.com/damoshen123/st-chatu8/tree/50f0d200caea17c448e80432f1b54d65ed8ce9cd) 和 [柏宝绘](https://github.com/baibai-git/ST-BaiBai-Image)。

采用 [MIT 许可证](LICENSE)。随包使用的图片编解码库说明见 [第三方声明](lib/vendor/NOTICE.md)。
