import { resolveCharacterForms } from './character-forms.js'
import { charactersFromWorldbookText, charactersFromCardBook, charactersFromExtraction, mergeCharacters } from './character-import.js'
import { buildMinorBatchPrompt, scrubMinorNegatives } from './character-import.js'
import { parseCharacters } from './character-generator.js'
import { buildOutfitPrompt, clampBatchCount, mergeOutfits, parseOutfits } from './outfit-generator.js'
/**
 * dsh-tavern-image —— DSH Tavern 多渠道场景生图插件（host 半边）。
 *
 * 它把三件事合成一个插件：
 *   1. 出图：按配置调用 ComfyUI 或其他生图渠道，将规划结果插入正文；
 *   2. 提示词：往系统提示词里注入"自动生图规则"，让模型知道该在哪、怎么写这些标记；
 *   3. 控制台：工作流库 / 人物库 / 生成记录 / 测试生成，一个网页搞定。
 *
 * 路由都挂在宿主自己的 web 服务上（同源，浏览器直接访问）：
 *   GET  /plugins/dsh-tavern-image/console           控制台页面
 *   GET  /plugins/dsh-tavern-image/state             控制台状态
 *   POST /plugins/dsh-tavern-image/config            保存设置
 *   POST /plugins/dsh-tavern-image/workflow          改一条工作流
 *   POST /plugins/dsh-tavern-image/reload            重扫 workflows/
 *   POST /plugins/dsh-tavern-image/definitions       保存人物库
 *   POST /plugins/dsh-tavern-image/generate          控制台里的"试一张"
 *   POST /plugins/dsh-tavern-image/jobs              建作业（浏览器渲染器用）
 *   GET  /plugins/dsh-tavern-image/jobs?id=&image=1  查作业 / 取图
 */
import { randomUUID, randomInt } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAutoImageGenPrompt } from './prompts.js'
import { installTavernBridge } from './tavern-bridge.js'
import { createPluginUpdater } from './updater.js'
import { IMAGE_PROVIDERS, generateImage, testImageChannel } from './image-providers.js'
import { normalizeChannels, publicChannels, activeChannel, channelConfigPatch } from './image-channels.js'
import { createCredentialStore } from './credential-store.js'
import { patchWorkflowGraph, workflowRevision } from './workflow-graph.js'
import { parseImagePlan, parsePlannerDecision, characterRoster, buildPlannerSystem, runPlanner, normalizePrompts, parseDesign } from './planner.js'
import { normalizeEntryActivation, selectPlannerContext } from './planner-context.js'
import { createDownloadPackage, PLUGIN_DOWNLOADS } from './download-package.js'
import { createMediaActions } from './media-actions.js'
import { applyCharacterSnapshot, boundCharacterSnapshot, emptyCharacterSnapshot, mergeCharacterUpdates } from './character-history.js'
import { getPromptGuidance } from './prompt-presets.js'
import { BUILTIN_PROMPT_PRESETS, normalizePromptPresets, resolvePromptMode, composePresetText, promptPresetNegative, effectivePromptPreset, formatPromptForBackend, validPromptPresetId, promptBackendContext } from './prompt-presets.js'
import { transcodeImageOutputAsync, isBlankImage } from './image-output.js'
import { buildComfySimpleWorkflow, inspectComfySimple, normalizeComfySimpleConfig } from './comfy-simple.js'
import { createDiagnostics } from './diagnostics.js'

export const name = 'dsh-tavern-image'
export const inject = ['webServer']

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Tavern 的数据根目录（data/），用来读它设置里的「默认后台模型」
const TAVERN_DATA = dirname(dirname(ROOT))
const TAVERN_SETTINGS = join(TAVERN_DATA, 'tavern-settings.json')
const BASE = '/plugins/dsh-tavern-image'
const LEGACY_BASE = '/plugins/dsh-tavern-comfy'
const CONFIG_PATH = join(ROOT, 'config.json')
const DEFS_PATH = join(ROOT, 'definitions.json')
const WORKFLOW_DIR = join(ROOT, 'workflows')
const CONSOLE_PATH = join(ROOT, 'console.html')
const AUTO_SECTION = 'dsh-tavern-image:auto-image'
const AUTO_SECTION_ORDER = 10150
let configWriteQueue = Promise.resolve()
// 密钥存 DSH 凭据服务；宿主没有这个服务时照旧明文留在 config.json。
const credentialStore = createCredentialStore({ save: config => saveConfig(config) })

const DEFAULTS = {
  imageBackend: 'comfyui',
  imageChannels: [],
  activeImageChannel: '',
  imageConcurrency: 2,
  comfyUrl: 'http://127.0.0.1:8188',
  comfyMode: 'workflow',
  comfySimple: normalizeComfySimpleConfig(),
  // 服务鉴权：none / bearer / basic
  comfyAuthMode: 'none',
  comfyAuthToken: '',
  comfyAuthUser: '',
  comfyAuthPass: '',
  defaultWorkflow: '',
  lockWorkflow: false,
  autoImageGen: false,
  imageGenCount: 2,
  smartImageSelection: true,
  characterAutoUpdate: true,
  // 画师串 / 风格：浏览器半边不传 artist 时用它（对应原来插件的「自定义画师串」）
  styleArtists: '',
  // 画风预设（参考 st-chatu8 的「提示词预设」）：
  //   每套 { id, name, artist, negative, position, enabled }
  //   artist  = 画师串 / 风格词（拼进正面）
  //   negative = 这套自带的负面固定词（会并进负面）
  stylePresets: [],
  // 当前用的预设 id（'' = 用下面的默认值）
  activePreset: '',
  // 默认负面固定词（没选预设时用）
  styleNegative: '',
  promptPresets: [],
  activePromptPreset: '',
  promptMode: 'auto',
  jpegOutput: false,
  jpegQuality: 88,
  jpegBackground: '#ffffff',
  // 默认画幅：竖图 / 横图 / 方图（规划模型给出 WxH 时优先用它的）
  imageSize: '竖图',
  // 正文插图的统一显示宽度（px）。0 = 默认，沿用正文原来的显示大小。
  // 注意它和上面的 imageSize 是两回事：imageSize 决定生成分辨率，这个只决定
  // 正文里的显示宽度 —— 不重采样原图、不改生成分辨率，也不影响点开后的全屏看图。
  imageDisplayWidth: 0,
  // ---- 生图规划（agent 生图）：另起一次模型调用，决定配几张、插在哪、提示词怎么写 ----
  plannerEnabled: true,
  plannerProvider: '',
  plannerModel: '',
  // 看图（参考图 / 照片识别）用的模型：必须是支持视觉的模型
  visionProvider: '',
  // 推理等级（模型的 reasoning effort）
  plannerEffort: '',
  visionEffort: '',
  visionModel: '',
  plannerCount: 3,
  plannerTemperature: 1,
  plannerExtra: '',
  // 世界书里哪几条进规划提示词；空数组 = 用默认的任务规则区
  plannerEntries: [],
  artistPosition: 'prefix',
  weightMode: 'convert',
  negativeMode: 'plugin',
  overrideSteps: false,
  injectWeight: 1.1,
  // 人物可见块怎么带：'auto' 按画面是否 NSFW 决定 / 'sfw' 永远只带常规块 / 'all' 全带
  traitMode: 'auto',
  queryThrottleMs: 400,
  cacheDir: 'cache',
  maxImageBytes: 32 * 1024 * 1024,
  workflows: [],
  sizes: { 竖图: { width: 512, height: 768 }, 横图: { width: 768, height: 512 }, 方图: { width: 640, height: 640 } },
  // 设置页可以改的这几项也要列在这里：saveConfig 只写 DEFAULTS 里有的键，漏掉的保存后重启就丢。
  promptManualPositive: '',
  promptManualNegative: '',
  // 已存进 DSH 凭据服务的密钥引用名（不是密钥本身）
  credentialRefs: [],
  artistSets: [],
  activeArtistSet: '',
}

// 正文插图显示宽度的取值范围（px）。写入、读盘、/state 都过这个函数，
// 保证配置里不会留下 NaN、负数或者能把正文撑爆的巨大宽度。
const IMAGE_DISPLAY_WIDTH = { min: 160, max: 2000 }

/**
 * 归一化「正文图片显示宽度」：空值 / 非数字 / <= 0 一律当 0（= 用正文默认显示效果），
 * 其余夹进 [160, 1200] 并取整。0 这个哨兵值表示"没设置过"，等于保持原来的显示。
 */
function normalizeImageDisplayWidth(value) {
  if (value === null || value === undefined || value === '') return 0
  const width = Number(value)
  if (!Number.isFinite(width) || width <= 0) return 0
  return Math.min(IMAGE_DISPLAY_WIDTH.max, Math.max(IMAGE_DISPLAY_WIDTH.min, Math.round(width)))
}

/** 人物库三类定义。continuity 默认不注入（它随剧情变）。 */
const DEFINITION_KINDS = {
  characters: { label: '人物', fields: ['name', 'match', 'appearance', 'outfit', 'continuity'] },
  settings: { label: '场景', fields: ['name', 'match', 'layout', 'materials', 'lighting', 'continuity'] },
  props: { label: '物件', fields: ['name', 'match', 'appearance', 'continuity'] },
}
const DEFAULT_OFF_FIELDS = new Set(['continuity'])

/**
 * 人物的"可见块"划分（借用 st-chatu8 的思路）：按看得见什么、什么视角、穿不穿，
 * 分别写。镜头切到哪一块就带哪一块，避免把全身细节全塞进一张近景。
 */
const CHARACTER_TRAITS = [
  ['feature', '角色特征'],
  ['face', '五官外貌'],
  ['faceBack', '五官外貌背面'],
  ['bodySFW', '上半身SFW'],
  ['bodySFWBack', '上半身SFW背面'],
  ['lowerSFW', '下半身SFW'],
  ['lowerSFWBack', '下半身SFW背面'],
  ['bodyNSFW', '上半身NSFW'],
  ['bodyNSFWBack', '上半身NSFW背面'],
  ['lowerNSFW', '下半身NSFW'],
  ['lowerNSFWBack', '下半身NSFW背面'],
  ['negative', '负面'],
]
/** 旧版字段名 → 新版，读老数据时用。 */
const LEGACY_TRAITS = { fullSFW: 'lowerSFW', fullNSFW: 'lowerNSFW', faceBack: 'faceBack' }
/** 出图时按 POV / 景别 / 穿不穿挑块（正面背面互斥）。 */
const BACK_VIEW = /\b(from behind|from back|back view|seen from behind|from the back|backside|doggystyle|reversed)\b/i
const FULL_FRAME = /\b(full body|cowboy shot|wide shot|feet|foot|legs|thighs|lower body|hips|ass|butt|pussy|kneel|sitting|lying|on back|on stomach)\b/i
/** 提示词里出现这些词，就认为这张是露的，带上 NSFW 块。 */
const NSFW_HINT = /\b(nsfw|nude|naked|topless|nipples?|pussy|cum|sex|penetration|penis|lingerie|underwear|bra|panties|undressed)\b/i
/**
 * 画面里有人没穿或只穿内衣（洗澡、裸体、内衣、亲密场景）。这种画面里插件不再自动补「当前穿着」或常穿，
 * 只认宏里明确写的衣服；否则会被补上一身日常衣服，和画面里写的内衣、裸体打架（洗澡时穿着外衣）。
 * 只对规划原文（去掉宏）判断：人物外貌里常见的 medium breasts 之类不能把每张图都当成裸露画面。
 */
// 画面写着赤脚：服装里的鞋袜不再加进去（服装库的整套衣服常带鞋，会和 barefoot 打架，模型照样画鞋）。
const BAREFOOT = /\b(barefoot|bare[- ]?feet|bare[- ]?foot|no shoes|shoeless|without shoes|shoes off|toes in (?:the )?(?:sand|water|grass|sea)|feet in (?:the )?(?:water|sand|sea)|(?:holding|carrying) (?:her |his |their )?(?:shoes|sneakers|sandals))\b/i
// 鞋本身拿在手里时，负面里不能写 shoes。
const SHOES_IN_HAND = /\b(?:holding|carrying) (?:her |his |their )?(?:shoes|sneakers|sandals)\b/i
const FOOTWEAR = /\b(shoes?|sneakers?|boots?|heels|high[- ]heels|sandals?|slippers?|loafers?|flats|pumps|socks?|clogs|geta|footwear|mary janes)\b/i
/** 去掉一段衣服描述里的鞋袜部分（按逗号分段）。 */
function dropFootwear(text) {
  return String(text ?? '').split(',').map(t => t.trim()).filter(t => t && !FOOTWEAR.test(t)).join(', ')
}
const GARMENT_WORDS = ['dress', 'gown', 'skirt', 'shirt', 'blouse', 'top', 'sweater', 'cardigan', 'hoodie', 'jacket', 'coat', 'vest', 'apron', 'kimono', 'yukata', 'robe', 'bathrobe', 'pajamas', 'uniform', 'suit', 'pants', 'trousers', 'jeans', 'shorts', 'leggings', 'swimsuit', 'bikini', 'towel', 'lingerie', 'bra', 'panties', 'underwear', 'stockings', 'pantyhose', 'socks', 'sneakers', 'boots', 'heels', 'sandals', 'slippers']
const HELD_ITEM = /\b(?:holding|carrying|lifting|raising|showing|in (?:her |his |their |own )?hands?|on (?:the )?(?:bed|hanger|floor|chair))\b/i
/**
 * 同一轮里换了衣服、画面宏又没写穿什么时，判断这张图是换之前还是换之后。
 * 只看画面描述（宏以外的部分）里提到的衣物词：手里拿着、放在一边的衣服不算。
 * 返回 'before' / 'after' / 'unclear'（判断不了，沿用换之后的）。
 */
export function pickOutfitForScene(scene, before, after) {
  const words = text => new Set(GARMENT_WORDS.filter(word => new RegExp('\\b' + word + 's?\\b', 'i').test(String(text ?? ''))))
  const worn = String(scene ?? '').split(',').filter(part => !HELD_ITEM.test(part)).join(',')
  const mentioned = words(worn)
  if (!mentioned.size) return 'unclear'
  const b = words(before), a = words(after)
  const score = set => [...mentioned].reduce((n, word) => n + (set.has(word) ? 1 : 0), 0)
  const sb = score(b), sa = score(a)
  if (sb > sa) return 'before'
  if (sa > sb) return 'after'
  return 'unclear'
}
const BARE_SCENE = /\b(nude|naked|topless|bottomless|half-naked|undress(?:ed|ing)?|unclothed|strip(?:ped|ping)|nipples?|breasts?|penis|pussy|sex|penetration|underwear|lingerie|bra|panties|thong|showering|taking a shower|in the shower|under the shower|bathing|in the bath(?:tub)?|soaking in the (?:tub|bath)|hot spring|onsen|skinny dipping|spread legs|exposed (?:waist|chest|skin|body|thighs?|hips?|belly|stomach))\b/i
const stripMacros = text => String(text ?? '').replace(/\$\{[\s\S]*?\}\$/g, ' ')
/** 「当前穿着」记录写的是没穿（全脱了）：什么衣服都不补，也不写 "is wearing naked" 这种句子。 */
const NOTHING_WORN = /^(?:nude|naked|nothing|no clothes|completely (?:nude|naked))\b|^(?:全裸|裸体|赤裸|一丝不挂|没穿|什么都没穿)/i

/** 通用服装库的字段（跨角色复用的一套衣服）。 */
const OUTFIT_FIELDS = ['body', 'full', 'bodyBack', 'fullBack', 'negative']

export function normalizeOutfit(raw, index) {
  const item = {
    id: String(raw?.id ?? `outfit-${index + 1}`),
    name: String(raw?.name ?? `通用服装 ${index + 1}`),
    enabled: raw?.enabled !== false,
  }
  for (const key of OUTFIT_FIELDS) item[key] = String(raw?.[key] ?? '')
  return item
}

/** 看照片写 tag 时用的规则。 */
const VISION_SYSTEM = [
  '你是视觉提示词助手。看用户给的图片，把这个人的外貌写成绘图模型能用的 tag（danbooru 风格英文标签，逗号分隔）。',
  '按可见部位分块返回，只输出 JSON，不要解释：',
  '{"face":"脸、发色发型、瞳色","faceBack":"后脑/颈背","bodySFW":"胸型腰背等上半身体态","fullSFW":"身高腿型臀脚","bodyNSFW":"上半身裸露特征，若是穿着正常的图就留空","fullNSFW":"全身裸露特征，同上","negative":"这张图里明显不该出现的特征，例如画成小孩"}',
  '规则：只写看得到的；宁可少写也别编；不确定的留空字符串；尺度不限，图里是什么就写什么，不要回避、不要审查。',
].join('\n')

/**
 * 角色 / 服装调用宏（st-chatu8 那种"名字→tag"的机制）：
 *   ${"name":"xiao yu","angle":"from front","upperBody":"sfw"}$
 *
 * 挑块规则（人物的稳定 DNA）：按规范挑块 —— 正面与背面互斥；穿衣服时只用 SFW 块
 * （NSFW 块会让衣服画不出来）；近景只带上半身，出现腿/脚/全身等词才带下半身。
 * 会去人物库找这个人，按 angle / upperBody 选出对应的外貌与服装 tag 展开；
 * 找不到人就退回原名，不会让提示词变空。
 */
export function expandRosterCalls(text, scoped, mode, options = {}) {
      // options.onMacro(entry)：诊断用，报告每个宏解析成了谁、哪套衣服、丢掉了哪些负面词。
      const note = (entry) => { if (typeof options?.onMacro === 'function') { try { options.onMacro(entry) } catch {} } }
      const natural = options?.style === 'natural'
      let lastPerson = null
      const nameKey = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-.'"（）()]+/g, '')
      const standaloneNames = new Set([...String(text ?? '').matchAll(/\$\{([\s\S]*?)\}\$/g)].flatMap((m) => {
        try { const c = JSON.parse('{' + m[1] + '}'); return [nameKey(stripUsualSuffix(c.name ?? c['名称'] ?? c['角色']))] } catch { return [] }
      }).filter(Boolean))
      const bareScene = BARE_SCENE.test(stripMacros(text))
      const sceneText = stripMacros(text)
      const barefoot = BAREFOOT.test(sceneText)
      // 服装的「背面」字段只在背影画面里用：画面写着背影，或者同一段里刚调用的人物宏 angle 是背面。
      const backView = BACK_VIEW.test(sceneText)
      let lastBack = false
      // 同一角色的不同形态：画面写着某形态的线索（如狐耳狐尾）时，宏改指向那个形态。
      return resolveCharacterForms(text, scoped).replace(/\$\{([\s\S]*?)\}\$/g, (_match, body) => {
        const source = String(body ?? '').trim()
        if (!source) return ''
        let parsed = null
        try { parsed = JSON.parse('{' + source + '}') } catch { return '' }
        if (!parsed || typeof parsed !== 'object') return ''
        const asked = stripUsualSuffix(parsed.name ?? parsed['名称'] ?? parsed['角色'])
        if (!asked) return ''
        const norm = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-.'"（）()]+/g, '')
        const key = norm(asked)
        const bits = []
        const pushOutfit = (outfit) => {
          for (const field of ['upper', 'lower', 'shoes', 'accessory', 'full', 'back']) {
            if (barefoot && field === 'shoes') continue
            if (field === 'back' && !(backView || lastBack)) continue
            const value = barefoot ? dropFootwear(outfit[field]) : String(outfit[field] ?? '').trim()
            if (value && !PLACEHOLDER_VALUE.test(value)) bits.push(value)
          }
        }

        // ① 人物库
        // 先精确匹配 id / 名字 / match 里的任一别名。
        // 旧写法用 includes 双向模糊匹配：match 为空的人物会匹配任何宏（'' 被任何字符串包含），
        // 短名字（如 "Li"）会匹配到含有它的别人的名字，「X fox form」也会命中排在前面的「X」。
        let matches = (scoped?.characters ?? []).filter((ch) => ch && ch.enabled !== false &&
          [ch.id, ch.name, ...splitTags(ch.match)].some((alias) => norm(alias) && norm(alias) === key))
        // 兼容短别名（如宏写 "A Mei"，人物 match 是 "A Mei human form"）：精确匹配不到时，
        // 允许别名以该名字开头或结尾（名字至少 3 个字符）；命中同一角色的多个形态时取基础条目（名字是其他候选前缀的那个）。
        if (!matches.length && key.length >= 3) {
          const loose = (scoped?.characters ?? []).filter((ch) => ch && ch.enabled !== false &&
            [ch.name, ...splitTags(ch.match)].some((alias) => { const n = norm(alias); return n && n !== key && (n.startsWith(key) || n.endsWith(key)) }))
          const base = loose.filter((ch) => loose.every((other) => other === ch || String(other.name ?? '').startsWith(String(ch.name ?? ''))))
          matches = loose.length <= 1 ? loose : (base.length === 1 ? base : loose)
        }
        // 仍然命中多个不同的人：不猜，保留原名，交给后面的按名字注入。
        if (matches.length > 1) note({ macro: source, asked, result: 'ambiguous', candidates: matches.map((ch) => String(ch.id ?? '')) })
        const person = matches.length === 1 ? matches[0] : null
        if (person) {
          const angle = String(parsed.angle ?? '').trim()
          const back = /back|behind|背面|背后/i.test(angle)
          lastBack = back
          const upper = String(parsed.upperBody ?? parsed.body ?? '').toLowerCase()
          const lower = String(parsed.lowerBody ?? '').toLowerCase()
          const nsfw = upper === 'nsfw' || lower === 'nsfw' || mode === 'all'
          const outfitName = stripUsualSuffix(parsed.outfit ?? parsed.clothes ?? parsed['服装'])
          // 衣服的优先级：宏里指定的服装库服装 > 宏里直接写的英文描述 > 之前正文记录的「当前穿着」> 常穿。
          // 同一段里另有属于此人的单独服装宏时，衣服交给那个宏。
          const hiddenBody = /hidden/i.test(upper) && /hidden/i.test(lower)
          const ownsStandalone = (person.outfits ?? []).some((o) => o && o.enabled !== false && standaloneNames.has(nameKey(o.name)))
          const libraryHit = outfitName && (person.outfits ?? []).some((o) => o && o.enabled !== false && o.name === outfitName)
          const macroText = outfitName && /^[\x20-\x7e]+$/.test(outfitName) && /[a-z]/i.test(outfitName) && !PLACEHOLDER_VALUE.test(outfitName)
          // 插件自动补的衣服（「当前穿着」记录、常穿）只在穿着衣服的画面里补：
          // 标了 nsfw、全身 hidden、画面写着洗澡/裸体/内衣，或者记录本身就是「没穿」时都不补。
          // 宏里明确写的衣服（例如半脱的内衣）不受影响，总是保留。
          const recordedNude = NOTHING_WORN.test(String(person.current?.outfit ?? '').trim())
          const autoOff = nsfw || hiddenBody || bareScene || recordedNude
          let wear = ''
          let wearMoment = ''
          if (!ownsStandalone && !libraryHit) {
            if (macroText) wear = outfitName
            else if (!outfitName && !autoOff && person.current?.outfit) {
              // 这一轮正文里换过衣服：按这张图的画面描述判断是换之前还是换之后。
              const afterWear = resolveWearText(person, person.current.outfit)
              const beforeWear = person.current.previous ? resolveWearText(person, person.current.previous) : ''
              const moment = person.current.previous ? pickOutfitForScene(sceneText, beforeWear || person.current.previous, afterWear) : 'after'
              wear = moment === 'before' ? beforeWear : afterWear
              wearMoment = person.current.previous ? moment : ''
            }
          }
          if (barefoot && wear) wear = dropFootwear(wear)
          const picked = characterTags(person, {
            nsfw,
            back,
            mode,
            upper,
            lower,
            barefoot,
            outfitName: outfitName || undefined,
            noOutfit: Boolean(wear) || ownsStandalone || (!libraryHit && autoOff),
          })
          const angleTag = angle && /front|back|side|behind|left|right|from/i.test(angle) ? angle : ''
          if (natural) bits.push(boundCharacterPhrase(person, picked, angleTag ? [angleTag] : [], wear))
          else {
            if (picked.tags.length) bits.push(...picked.tags)
            if (wear) bits.push(wear)
            if (angleTag) bits.push(angleTag)
          }
          note({ macro: source, asked, result: 'character', characterId: String(person.id ?? ''), characterName: String(person.name ?? ''), outfitAsked: outfitName, outfitResult: outfitName ? (libraryHit ? 'found' : (wear ? 'free-text' : 'not-found')) : 'none-requested', wear, ...(wearMoment ? { wearMoment } : {}), droppedNegatives: picked.negative, origins: picked.origins })
          lastPerson = person
        }

        // ② 服装：先找通用服装库；找不到再找人物条目下的服装
        //    （世界书教规划单独写服装宏，而大多数衣服挂在人物身上）。
        //    优先找同一段里刚调用过的人物，避免重名服装串到别人身上。
        if (!person) {
          const enabled = (o) => o && o.enabled !== false
          let outfit = (scoped?.outfits ?? []).find((o) => enabled(o) && (norm(o.name) === key || norm(o.id) === key))
          let owner = null
          if (!outfit) {
            const owners = [...(lastPerson ? [lastPerson] : []), ...(scoped?.characters ?? []).filter((ch) => ch && ch.enabled !== false)]
            for (const candidate of owners) {
              outfit = (candidate.outfits ?? []).find((o) => enabled(o) && (norm(o.name) === key || norm(o.id) === key))
              if (outfit) { owner = candidate; break }
            }
          }
          if (outfit) pushOutfit(outfit)
          note({ macro: source, asked, result: outfit ? (owner ? 'character-outfit' : 'shared-outfit') : 'not-found', outfitId: outfit ? String(outfit.id ?? '') : '', ownerId: owner ? String(owner.id ?? '') : '' })
        }

        // ③ 都没有：保留原名（总比空着好）
        if (!bits.length) bits.push(asked)
        return bits.join(', ')
      })
    }

/** 规划有时把角色清单里的「（常穿）」标记一起抄进宏里；匹配服装名前去掉它。 */
function stripUsualSuffix(value) {
  return String(value ?? '').trim().replace(/\s*[（(]\s*(?:这套是)?常穿\s*[)）]\s*$/, '')
}

/** 同一角色的不同形态：名字互为前缀（如「阿梅」与「阿梅（狐形）」）。 */
function sameCharacterFamily(a, b) {
  const x = String(a?.name ?? ''), y = String(b?.name ?? '')
  return Boolean(a && b && a !== b && x && y && (x.startsWith(y) || y.startsWith(x)))
}

/**
 * 自然语言后端（Z-Image、Flux、在线 API…）里，把一个人的外貌和衣服写成绑定到他本人的一句话：
 *   "<英文名> is the woman in this scene: <外貌>; she is wearing <衣服>"
 * 逗号堆在一起的特征没有主语，多人画面里模型会把一个人的发色、耳朵套到另一个人身上。
 */
function boundCharacterPhrase(person, picked, extras = [], wear = '') {
  const label = splitTags(person?.match)[0] || String(person?.name ?? '')
  const origins = (picked?.origins ?? []).filter(o => o.channel !== 'negative')
  const traits = origins.filter(o => !o.outfitId).map(o => o.text)
  const outfit = origins.filter(o => o.outfitId).map(o => o.text)
  const look = [person?.traits?.face, person?.traits?.faceBack, person?.traits?.feature].map(v => String(v ?? '')).join(' ')
  const who = /\b(woman|girl|female|lady)\b/i.test(look) ? ['the woman', 'she']
    : /\b(man|boy|male|gentleman)\b/i.test(look) ? ['the man', 'he'] : ['a character', 'they']
  let phrase = label + ' is ' + who[0] + ' in this scene: ' + traits.join(', ')
  const wearing = who[1] === 'they' ? ' are wearing ' : ' is wearing '
  if (outfit.length) phrase += '; ' + who[1] + wearing + outfit.join(', ')
  else if (wear) phrase += '; ' + who[1] + wearing + wear
  if (extras.length) phrase += ', ' + extras.join(', ')
  return phrase
}

/** 服装条目 → 一句完整描述。 */
function outfitDescription(outfit) {
  return ['upper', 'lower', 'shoes', 'accessory'].map(k => String(outfit?.[k] ?? '').trim()).filter(v => v && !PLACEHOLDER_VALUE.test(v)).join(', ')
}

/** 「当前穿着」记录可能是英文描述，也可能是服装库里的名字；是名字就展开成那套衣服。 */
function resolveWearText(person, text) {
  const value = String(text ?? '').trim()
  if (!value || NOTHING_WORN.test(value)) return ''
  const n = v => String(v ?? '').toLowerCase().replace(/[\s_\-.'"（）()]+/g, '').replace(/常穿$/, '')
  const find = piece => (person?.outfits ?? []).find(o => o && o.enabled !== false && n(o.name) && n(o.name) === n(piece))
  const whole = find(value)
  if (whole) return outfitDescription(whole) || value
  // 规划有时把服装名和补充的单品混着写（「酒红色挂脖包臀裙, black pantyhose」）：逐段展开服装名，
  // 其余英文原样保留，认不出的中文片段丢掉（模型看不懂，只会干扰画面）。
  const seen = new Set()
  const pieces = value.split(/[,，、]/).map(t => t.trim()).filter(Boolean).flatMap(piece => {
    const hit = find(piece)
    if (hit) return String(outfitDescription(hit) || '').split(',').map(t => t.trim()).filter(Boolean)
    return /[\u3400-\u9fff]/.test(piece) ? [] : [piece]
  }).filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  return pieces.length ? pieces.join(', ') : value
}

/** 人物宏展开 / 规范化用自然语言还是 tag 写法（与 prepareImagePrompt 的判断一致）。 */
function rosterStyle(config, workflow = null) {
  return resolvePromptMode(config, promptBackendContext(config, workflow)) === 'natural' ? 'natural' : 'tags'
}

/** 服装字段里的占位值（如 "none"）不写进提示词。 */
const PLACEHOLDER_VALUE = /^(?:none|n\/a|null|undefined|无|没有)$/i

function characterTags(character, options = {}) {
  if (!character || character.enabled === false) return { tags: [], negative: [] }
  const traits = character.traits ?? {}
  const back = options.back === true
  const nsfw = options.nsfw === true || options.mode === 'all'
  const full = options.full !== false
  const keys = ['feature', back ? 'faceBack' : 'face']
  // 宏里分别给了上下身状态时按部位挑：上身露、下身穿着，就只带上身的 NSFW 块，反之亦然；hidden 的部位不带。
  // 没分别给（或 traitMode 为 all）时和以前一样，整个人一起按 nsfw / sfw 挑。
  const part = value => { const v = String(value ?? '').toLowerCase(); return v === 'nsfw' || v === 'hidden' || v === 'sfw' ? v : '' }
  const upperPart = options.mode === 'all' ? 'nsfw' : (part(options.upper) || (nsfw ? 'nsfw' : 'sfw'))
  const lowerPart = options.mode === 'all' ? 'nsfw' : (part(options.lower) || (nsfw ? 'nsfw' : 'sfw'))
  if (upperPart !== 'hidden') keys.push(upperPart === 'nsfw' ? (back ? 'bodyNSFWBack' : 'bodyNSFW') : (back ? 'bodySFWBack' : 'bodySFW'))
  if (full && lowerPart !== 'hidden') keys.push(lowerPart === 'nsfw' ? (back ? 'lowerNSFWBack' : 'lowerNSFW') : (back ? 'lowerSFWBack' : 'lowerSFW'))
  const tags = []
  const negative = []
  const origins = []
  const negativeRaw = String(traits.negative ?? '').trim()
  if (negativeRaw && !PLACEHOLDER_VALUE.test(negativeRaw)) { negative.push(negativeRaw); origins.push({ field: 'traits.negative', channel: 'negative', text: negativeRaw }) }
  for (const key of keys) {
    const value = String(traits[key] ?? '').trim()
    if (value && !PLACEHOLDER_VALUE.test(value)) { tags.push(value); origins.push({ field: 'traits.' + key, text: value }) }
  }
  for (const outfit of options.noOutfit ? [] : character.outfits ?? []) {
    if (outfit?.enabled === false) continue
    const isDefault = outfit.default === true
    if (options.outfitId) { if (outfit.id !== options.outfitId) continue }
    // 指名要某套衣服时按名字找；没指名时才退回常穿（或第一套）。
    else if (options.outfitName) { if (outfit.name !== options.outfitName) continue }
    else if (!isDefault && (character.outfits ?? []).some(o => o.default && o.enabled !== false)) continue
    for (const key of ['upper', 'lower', 'shoes', 'accessory', 'full']) {
      if (options.barefoot && key === 'shoes') continue
      const value = options.barefoot ? dropFootwear(outfit[key]) : String(outfit[key] ?? '').trim()
      if (value && !PLACEHOLDER_VALUE.test(value)) { tags.push(value); origins.push({ field: 'outfit.' + key, outfitId: outfit.id, text: value }) }
    }
    if (options.back === true && String(outfit.back ?? '').trim()) {
      tags.push(String(outfit.back).trim())
      origins.push({ field: 'outfit.back', outfitId: outfit.id, text: String(outfit.back).trim() })
    }
    if (outfit.negative) { negative.push(String(outfit.negative).trim()); origins.push({ field: 'outfit.negative', channel: 'negative', outfitId: outfit.id, text: String(outfit.negative).trim() }) }
    break
  }
  return { tags, negative, origins }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const deps = { llm: null, attachments: null, subagents: null, sessions: null }
  // 诊断用：DSH 往 index.html 注入的 script 行，就是客户端模块的加载清单
  const indexTap = { rows: null, at: 0, htmlLength: 0 }
  deps.indexTap = indexTap
  let runtime = null
  const ready = () => (runtime ??= createRuntime(ctx, config, logger, deps))

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      const web = scoped.webServer
      if (!web || typeof web.tapIndex !== 'function') return
      const install = () => web.tapIndex(html => {
        try {
          const all = String(html).match(/<script[^>]*>/gi) || []
          indexTap.rows = all.filter(row => /rphub|wrongbook|client|module/i.test(row)).slice(0, 40)
          if (!indexTap.rows.length) indexTap.rows = all.slice(0, 25)
          indexTap.at = Date.now()
          indexTap.htmlLength = String(html).length
        } catch { /* 诊断失败不影响页面 */ }
        return html
      })
      if (typeof scoped.effect === 'function') scoped.effect(install, 'dsh-tavern-image: index tap (diagnostic)')
      else install()
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], scoped => { deps.llm = scoped.llm })
    ctx.inject(['credentials'], scoped => {
      credentialStore.connect(scoped.credentials).catch(error => logger.warn?.('dsh-tavern-image: 凭据服务接入失败：' + (error?.message ?? error)))
    })
    // 上传照片要先把图片存成附件，模型才收得到
    ctx.inject(['attachments'], scoped => { deps.attachments = scoped.attachments })
    ctx.inject(['subagents'], scoped => { deps.subagents = scoped.subagents })
    // 正文由宿主直接读：这样不依赖任何前端的渲染钩子
  // runtime 懒建：第一次用到才创建（createRuntime 是函数声明，已提升，这里提前引用安全）

    ctx.inject(['sessions'], scoped => { deps.sessions = scoped.sessions })
    // Tavern 官方插件接口（宿主侧）：轮次事件、读正文与设定、挂媒体、提示词段落
    // Tavern 官方插件接口（宿主侧）：轮次事件、读正文与设定、挂媒体、提示词段落。
    // 装桥放在这里 —— 服务一到就装。不能放进 createRuntime：runtime 是懒建且只建一次的，
    // 服务没就绪时创建过那一次，之后桥就永远装不上了（2026-10-07 就是这么坏的）。
    ctx.inject(['tavern'], scoped => {
      const tavern = scoped.tavern
      deps.tavern = tavern
      if (!tavern || typeof tavern.attach !== 'function' || typeof tavern.promptSection !== 'function') {
        logger.warn?.('dsh-tavern-image: 当前 Tavern 没有插件接口（tavern.attach），生图链路退回旧方式')
        return
      }
      const install = () => {
        let disposed = false
        const lifecycleDisposes = []
        // ready() 是异步的：createRuntime 内部是 async IIFE，返回 Promise，必须 await。
        const boot = async () => {
          const engine = await ready()
          if (disposed) return
          const attachmentApi = {
            saveImage: (...args) => {
              if (typeof deps.attachments?.saveImage !== 'function') throw new Error('当前 Tavern 的官方附件服务尚未就绪')
              return deps.attachments.saveImage(...args)
            },
          }
          try { logger.info?.('dsh-tavern-image: 官方桥 engine 导出键 = ' + Object.keys(engine ?? {}).join(',')) } catch {}
          deps.bridge = installTavernBridge({
            tavern,
            attachments: attachmentApi,
            engine: { planMessage: engine.planMessage, getJob: id => engine.getJob(id), cancelJob: id => engine.cancelJob(id) },
            getConfig: () => engine.currentConfig(),
            logger,
            readFileAsBytes: async file => new Uint8Array(await readFile(file)),
            // 每轮结算时把「哪张卡、第几轮」记下来（官方接口给的 card，不用自己翻会话目录）
            onTurn: turn => deps.rememberTurn?.(turn?.gameId, turn?.turn, turn?.card),
            onTimeline: event => { deps.rememberTimeline?.(event); deps.mediaActions?.timelineChanged(event) },
          })
          deps.mediaActions = createMediaActions({
            tavern, attachments: attachmentApi,
            getJob: id => engine.getJob(id), startReplacement: input => engine.startReplacement(input),
            cancelJob: id => engine.cancelJob(id), refreshJob: (id, options) => { const job = engine.getJob(id); if (job) return engine.refresh(job, options) },
            readFileAsBytes: async file => new Uint8Array(await readFile(file)), logger,
          })
          if (typeof tavern.onGameRemoved === 'function') {
            const off = tavern.onGameRemoved(event => deps.mediaActions?.gameRemoved(event))
            if (typeof off === 'function') lifecycleDisposes.push(off)
          }
          logger.info?.('dsh-tavern-image: Tavern 官方接口桥已安装')
        }
        boot().catch(error => logger.warn?.('dsh-tavern-image: 官方接口桥安装失败 ' + (error?.message ?? error)))
        // ctx.effect 只接受同步返回的清理函数，所以这里同步返回
        return () => {
          disposed = true
          try { deps.bridge?.dispose?.(); deps.mediaActions?.dispose?.() } catch {}
          for (const off of lifecycleDisposes) { try { off() } catch {} }
        }
      }
      if (typeof scoped.effect === 'function') scoped.effect(install, 'dsh-tavern-image: Tavern 官方接口桥')
      else { try { install() } catch (error) { logger.warn?.('dsh-tavern-image: 官方接口桥安装失败 ' + (error?.message ?? error)) } }
    })
  }

  const route = (path, handler) => {
    const paths = [path]
    if (path.startsWith(BASE + '/')) paths.push(LEGACY_BASE + path.slice(BASE.length))
    for (const routePath of paths) {
      const install = () => ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: (request, response) => {
          const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
          Promise.resolve(ready().then(engine => handler(request, response, url, engine)))
            .catch(error => {
              logger.error?.(`dsh-tavern-image: ${error?.message ?? error}`)
              if (!response.headersSent) sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
              else response.end()
            })
        },
      })
      if (typeof ctx.effect === 'function') ctx.effect(install, `dsh-tavern-image: ${routePath}`)
      else install()
    }
  }

  route(`${BASE}/console`, serveConsole)
  route(`${BASE}/state`, (request, response, url, engine) => engine.handleConsole('state', request, response, url))
  route(`${BASE}/plugin-update`, (request, response, url, engine) => engine.handleConsole('plugin-update', request, response, url))
  route(`${BASE}/plugin-update/check`, (request, response, url, engine) => engine.handleConsole('plugin-update-check', request, response, url))
  route(`${BASE}/plugin-update/apply`, (request, response, url, engine) => engine.handleConsole('plugin-update-apply', request, response, url))
  route(`${BASE}/config`, (request, response, url, engine) => engine.handleConsole('config', request, response, url))
  route(`${BASE}/workflow`, (request, response, url, engine) => engine.handleConsole('workflow', request, response, url))
  route(`${BASE}/reload`, (request, response, url, engine) => engine.handleConsole('reload', request, response, url))
  route(`${BASE}/definitions`, (request, response, url, engine) => engine.handleConsole('definitions', request, response, url))
  route(`${BASE}/import-characters`, (request, response, url, engine) => engine.handleConsole('import-characters', request, response, url))
  route(`${BASE}/generate`, (request, response, url, engine) => engine.handleConsole('generate', request, response, url))
  route(`${BASE}/history`, (request, response, url, engine) => engine.handleConsole('history', request, response, url))
  route(`${BASE}/character-history`, (request, response, url, engine) => engine.handleConsole('character-history', request, response, url))
  route(`${BASE}/plan`, (request, response, url, engine) => engine.handleConsole('plan', request, response, url))
  route(`${BASE}/plans`, (request, response, url, engine) => engine.handleConsole('plans', request, response, url))
  route(`${BASE}/vision`, (request, response, url, engine) => engine.handleConsole('vision', request, response, url))
  route(`${BASE}/design`, (request, response, url, engine) => engine.handleConsole('design', request, response, url))
  route(`${BASE}/cancel`, (request, response, url, engine) => engine.handleConsole('cancel', request, response, url))
  route(`${BASE}/report`, (request, response, url, engine) => engine.handleConsole('report', request, response, url))
  route(`${BASE}/img`, (request, response, url, engine) => engine.handleConsole('img', request, response, url))
  route(`${BASE}/cards`, (request, response, url, engine) => engine.handleConsole('cards', request, response, url))
  route(`${BASE}/delete-job`, (request, response, url, engine) => engine.handleConsole('delete-job', request, response, url))
  route(`${BASE}/worldbook-import`, (request, response, url, engine) => engine.handleConsole('worldbook-import', request, response, url))
  route(`${BASE}/worldbook-entry`, (request, response, url, engine) => engine.handleConsole('worldbook-entry', request, response, url))
  route(`${BASE}/worldbook-add`, (request, response, url, engine) => engine.handleConsole('worldbook-add', request, response, url))
  route(`${BASE}/worldbook-export`, (request, response, url, engine) => engine.handleConsole('worldbook-export', request, response, url))
route(`${BASE}/generate-outfits`, (request, response, url, engine) => engine.handleConsole('generate-outfits', request, response, url))
  route(`${BASE}/generate-outfits-bulk`, (request, response, url, engine) => engine.handleConsole('generate-outfits-bulk', request, response, url))
route(`${BASE}/generate-characters-minor`, (request, response, url, engine) => engine.handleConsole('generate-characters-minor', request, response, url))
  route(`${BASE}/plugin-download`, (request, response, url, engine) => engine.handleConsole('plugin-download', request, response, url))
  route(`${BASE}/media-action`, (request, response, url, engine) => engine.handleConsole('media-action', request, response, url))
  route(`${BASE}/workflow-import`, (request, response, url, engine) => engine.handleConsole('workflow-import', request, response, url))
  route(`${BASE}/workflow-bindings`, (request, response, url, engine) => engine.handleConsole('workflow-bindings', request, response, url))
  route(`${BASE}/workflow-test`, (request, response, url, engine) => engine.handleConsole('workflow-test', request, response, url))
  route(`${BASE}/workflow-values`, (request, response, url, engine) => engine.handleConsole('workflow-values', request, response, url))
  route(`${BASE}/workflow-graph`, (request, response, url, engine) => engine.handleConsole('workflow-graph', request, response, url))
  route(`${BASE}/image-channel-test`, (request, response, url, engine) => engine.handleConsole('image-channel-test', request, response, url))
  route(`${BASE}/llm-models`, (request, response, url, engine) => engine.handleConsole('llm-models', request, response, url))
  route(`${BASE}/comfy-test`, (request, response, url, engine) => engine.handleConsole('comfy-test', request, response, url))
  route(`${BASE}/comfy-simple-info`, (request, response, url, engine) => engine.handleConsole('comfy-simple-info', request, response, url))
  route(`${BASE}/loras-available`, (request, response, url, engine) => engine.handleConsole('loras-available', request, response, url))
  route(`${BASE}/job-detail`, (request, response, url, engine) => engine.handleConsole('job-detail', request, response, url))
  route(`${BASE}/redraw`, (request, response, url, engine) => engine.handleConsole('redraw', request, response, url))
  route(`${BASE}/improve-prompt`, (request, response, url, engine) => engine.handleConsole('improve-prompt', request, response, url))
  route(`${BASE}/jobs`, (request, response, url, engine) => handleJobs(request, response, url, engine))
  // 手动配图：浏览器侧「🎨 生图」按钮走这条，链路和自动配图完全一致
  route(`${BASE}/attach-turn`, handleAttachTurn)

  registerImageTool(ctx, ready)
  // 已停用（改用 Tavern 官方 promptSection + attach 链路）：installImageToolHint(ctx)
  // 已停用（改用 Tavern 官方 promptSection + attach 链路）：installAutoImagePrompt(ctx, ready)
  logger.info?.('dsh-tavern-image: 已加载（控制台 ' + BASE + '/console）')
}

// =====================================================================
// 路由：控制台页面 / 作业
// =====================================================================

async function serveConsole(request, response, _url, engine) {
  if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  const html = await engine.consoleHtml()
  if (!html) { sendJson(response, 404, { ok: false, error: 'console.html 不存在' }); return }
  const body = Buffer.from(html, 'utf8')
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.byteLength, 'cache-control': 'no-store' })
  response.end(body)
}

/** 手动配图：把某一轮交给官方桥（规划 → 出图 → attach 进正文）。 */
async function handleAttachTurn(request, response, _url, engine) {
  if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  try {
    const body = await engine.readBody(request)
    const gameId = String(body?.gameId ?? '')
    const turn = Number(body?.turn ?? 0)
    if (!gameId || !Number.isFinite(turn) || turn < 1) { sendJson(response, 400, { ok: false, error: '需要 gameId 与 turn' }); return }
    const result = await engine.attachTurn({ gameId, turn })
    sendJson(response, 200, { ok: true, ...result })
  } catch (error) {
    sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
  }
}

async function handleJobs(request, response, url, engine) {
  if (request.method === 'POST') {
    const body = await engine.readBody(request)
    sendJson(response, 200, await engine.startJob(body, { label: String(body?.origin ?? '') }))
    return
  }
  if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  const id = String(url.searchParams.get('id') ?? '')
  const key = String(url.searchParams.get('key') ?? '')
  let job = id ? engine.getJob(id) : engine.findJob(key)
  if (job) await engine.refresh(job)
  if (!job) { sendJson(response, 404, { ok: false, error: 'job-not-found' }); return }
  if (url.searchParams.get('image') === '1') { engine.sendImage(response, job, request.headers.range); return }
  sendJson(response, 200, { ok: true, job: engine.publicJob(job) })
}

// =====================================================================
// 生图工具：让前台模型写完正文后主动调一次
// =====================================================================

const TOOL_NAME = 'generate_scene_images'

function registerImageTool(ctx, ready) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['tools'], scoped => {
    const tools = scoped.tools
    const diag = { hasService: Boolean(tools), hasRegister: typeof tools?.register === 'function' }
    if (typeof globalThis !== 'undefined') globalThis.__rphubToolsDiag = diag
    if (!tools || typeof tools.register !== 'function') {
      diag.error = '没有 tools 服务'
      scoped.logger?.warn?.('dsh-tavern-image: 当前 DSH 没有 tools 服务，生图工具未注册')
      return
    }
    const definition = {
      name: TOOL_NAME,
      description: '为刚刚写好的这一轮正文生成插图。写完正文后调用一次，把正文原文原样传进来；'
        + '插件会在后台按当前卡片的设定与世界书规划画面、调用已配置的生图渠道，并把图插到正文对应句子后面。'
        + '没有开启生图或不需要配图时不要调用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '刚写好的正文原文（完整，不要摘要、不要改写）' },
          count: { type: 'number', description: '这一轮想要几张，留空则按插件设置' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            generated: { type: 'number' },
            note: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: String(value && value.note ? value.note : '已处理配图请求') }],
      },
      async execute(args, exec) {
        const engine = await ready()
        const input = args && typeof args === 'object' ? args : {}
        const body = String(input.text ?? '').trim()
        if (!body) return { ok: false, generated: 0, note: '没收到正文，无法配图' }
        const result = await engine.planFromTool({
          text: body,
          count: input.count,
          sessionId: exec?.agent?.id ? String(exec.agent.id) : '',
        })
        return result
      },
    }
    const install = () => {
      try {
        const dispose = tools.register(definition)
        diag.registered = true
        try {
          const found = typeof tools.get === 'function' ? tools.get(TOOL_NAME) : undefined
          diag.visible = Boolean(found)
        } catch (error) { diag.getError = String(error?.message ?? error) }
        try {
          if (typeof tools.schemas === 'function') {
            const names = (tools.schemas() ?? []).map(s => String(s?.name ?? ''))
            diag.totalTools = names.length
            diag.foundInSchemas = names.includes(TOOL_NAME)
          }
        } catch (error) { diag.schemasError = String(error?.message ?? error) }
        return dispose
      } catch (error) {
        diag.registerError = String(error?.message ?? error)
        throw error
      }
    }
    if (typeof scoped.effect === 'function') scoped.effect(install, 'dsh-tavern-image: ' + TOOL_NAME)
    else install()
  })
}

/** 告诉前台模型：写完正文后请调用生图工具。 */
function installImageToolHint(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['systemPrompt'], scoped => {
    const systemPrompt = scoped.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const register = () => systemPrompt.section({
      name: 'dsh-tavern-image:image-tool-hint',
      order: AUTO_SECTION_ORDER + 1,
      text: () => [
        '## 配图',
        '写这一轮正文**之前**，先把准备写的正文原文传给 ' + TOOL_NAME + ' 工具（参数 text）。',
        '工具会返回若干插图标记（形如 [[img:xxxxxxxx]]），每条都写明该插在哪句话之后。',
        '你把标记**原样**插进正文对应句子之后，再输出正文。标记会由界面渲染成图片。',
        '标记的写法一个字都不能改（不要加空格、不要翻译、不要解释它），也不要自己编造新的标记。',
        '正文其余部分照常写，不需要描述画面。',
      ].join('\n'),
    })
    if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-tavern-image: image tool hint')
    else register()
  })
}

// =====================================================================
// 自动生图提示词注入
// =====================================================================

function installAutoImagePrompt(ctx, ready) {
  if (typeof ctx.inject !== 'function') return
  // 拿到的就是运行时那个 config 对象本身，所以控制台一改开关，下一次装配立刻生效。
  let configRef = null
  ready()
    .then(engine => { configRef = engine.currentConfig() })
    .catch(error => ctx.logger?.warn?.('dsh-tavern-image: 自动生图规则未就绪：' + (error?.message ?? error)))
  ctx.inject(['systemPrompt'], scoped => {
    const systemPrompt = scoped.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      scoped.logger?.warn?.('dsh-tavern-image: 当前 DSH 没有 systemPrompt.section，自动生图规则未注入')
      return
    }
    const register = () => systemPrompt.section({
      name: AUTO_SECTION,
      order: AUTO_SECTION_ORDER,
      text: () => (configRef?.autoImageGen ? buildAutoImageGenPrompt(configRef.imageGenCount) : ''),
    })
    if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-tavern-image: auto image section')
    else register()
  })
}

// =====================================================================
// 引擎
// =====================================================================

function createRuntime(ctx, overrides, logger, deps) {
  const updater = createPluginUpdater({ root: ROOT, getApiVersion: () => deps.tavern?.apiVersion })
  return (async () => {
    const config = await loadConfig(overrides)
    // 诊断日志：默认关闭；插件目录下放 diagnostics.json 打开（见 lib/diagnostics.js）。
    const diag = createDiagnostics({ root: ROOT, logger, secrets: () => collectSecretValues(config) })
    config.workflows = await scanWorkflows(config)
    let definitions = await loadDefinitions()
    let workflows = []
    const jobs = new Map()
    // 出全黑图时用来换种子重画：jobId → { prompt, seedBindings }（只在内存里，重启后不重画）。
    const blankRetry = new Map()
    const BLANK_RETRIES = 2
    const byKey = new Map()
    const endpointOf = value => {
      try { const url = new URL(String(value)); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().replace(/\/$/, '') }
      catch { return '' }
    }
    const channelEndpointOf = channel => endpointOf(channel?.baseUrl || IMAGE_PROVIDERS.find(item => item.id === channel?.provider)?.baseUrl)

    // ---- 作业落盘：图文件本来就在 cache/ 里，缺的是这份元数据 ----
    const JOBS_STORE = join(ROOT, 'jobs-store.json')
    function restoreJobs() {
      return (async () => {
        try {
          const saved = await readJson(JOBS_STORE, null)
          if (saved && typeof saved === 'object') {
            const fileExists = async p => { try { await stat(p); return true } catch { return false } }
            for (const item of Object.values(saved)) {
              if (!item || !item.id) continue
              const job = Object.assign({}, item, { params: item.params ?? {} })
              // 老记录有两处会让取图永久 404，这里在内存里补正（不写回盘，每次启动重算）：
              //   ① file 指着改名前的 cache 目录（…\tools\dsh-tavern-image\cache\…），文件其实已搬到 dsh-tavern-image；
              //   ② byteLength 被早期兜底恢复写成了 0，而取图门槛正是 `if (!job.file || !job.byteLength)`。
              if (!job.file || !(await fileExists(job.file))) {
                for (const ext of ['.img', '.png', '.jpg', '.jpeg', '.webp']) {
                  const guess = join(cacheRoot(config), String(job.id) + ext)
                  if (await fileExists(guess)) { job.file = guess; break }
                }
              }
              if (job.file) {
                try {
                  const info = await stat(job.file)
                  if (info.size) {
                    job.byteLength = info.size
                    // 文件在就说明这一张已经画完了。重启后内存里不可能还留着真正在跑的作业，
                    // 而落盘时残留的 pending 会让 hasImage 判成 false —— 历史图列表里
                    // 明明有图却显示「没有」，缩略图也出不来。以文件为准修正状态。
                    if (job.state !== 'done') {
                      job.state = 'done'
                      job.percent = 100
                      job.error = undefined
                    }
                  }
                } catch { /* 文件真的不在就保持原样 */ }
              }
              if (!job.mediaType) {
                try { job.mediaType = imageMediaTypeFromBytes(await readFile(job.file)) || 'image/png' }
                catch { job.mediaType = 'image/png' }
              }
              if (job.backend && job.backend !== 'comfyui' && ['pending', 'running'].includes(job.state)) {
                job.requestMayHaveSucceeded = job.requestStarted === true || job.state === 'running'
                job.state = job.requestMayHaveSucceeded ? 'uncertain' : 'failed'
                job.error = job.requestMayHaveSucceeded ? '插件重启后无法确认平台是否已接单；请先在平台检查任务，未自动重试' : '插件重启中断了尚未提交的排队任务，可以手动重试'
              }
              // byKey 只在 startJob 里写过，重启后是空的 —— 而"同一个 key 只画一次"的去重
              // （InlineImage 先查 /jobs?key=、startJob 里 findJob(key)）全靠它。
              // 不重建的话，重启后同一段正文会被重复提交、重复作画。
              if (job.key) byKey.set(String(job.key), String(item.id))
              jobs.set(String(item.id), job)
            }
          }
        } catch { /* 读不到就当没有 */ }
        // 兜底：cache 目录里有图但没记录的，按"已完成"补回来
        try {
          const dir = cacheRoot(config)
          const names = await readdir(dir).catch(() => [])
          let added = 0
          for (const name of names) {
            const hit = /^([0-9a-f-]{36})\.(?:img|png|jpe?g|webp)$/i.exec(name)
            if (!hit) continue
            const id = hit[1]
            if (jobs.has(id)) continue
            let size = null
            // byteLength 必须填成文件的真实字节数：取图路由的门槛是 `if (!job.file || !job.byteLength)`，
            // 填 0 会让这个作业永远被判成「图片还没生成好」而返回 404 —— 列表里明明有图却打不开。
            let bytes = 0
            try {
              const buf = await readFile(join(dir, name))
              bytes = buf.length
              if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4e) size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
            } catch { /* 读不到尺寸就算了 */ }
            const cached = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
            jobs.set(id, { id, state: 'done', percent: 100, createdAt: Date.now(), file: join(dir, name), size, params: {}, label: '历史图片', byteLength: bytes, mediaType: imageMediaTypeFromBytes(cached) || (/\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png') })
            added++
          }
          if (added) logger.info?.('dsh-tavern-image: 从 cache 补回 ' + added + ' 张历史图片')
        } catch { /* 忽略 */ }
        if (jobs.size) logger.info?.('dsh-tavern-image: 作业记录共 ' + jobs.size + ' 条')
      })()
    }
    let jobsDirty = false
    let jobsWritePromise = Promise.resolve()
    function persistJobs() {
      jobsDirty = true
      jobsWritePromise = jobsWritePromise.then(async () => {
        if (!jobsDirty) return
        jobsDirty = false
        try {
          const entries = [...jobs.entries()].slice(-150)
          const plain = {}
          for (const [id, job] of entries) {
            plain[id] = {
              id: job.id, state: job.state, percent: job.percent ?? 0, createdAt: job.createdAt,
              workflowId: job.workflowId, outputNode: job.outputNode,
              file: job.file, size: job.size ?? null, params: job.params ?? {}, label: job.label ?? '',
              positive: job.positive ?? '', negative: job.negative ?? '',
              byteLength: job.byteLength ?? 0, mediaType: job.mediaType ?? '', seed: job.seed ?? null,
              error: job.error ?? undefined,
              // 落盘 key，重启后才能重建 byKey（见 restoreJobs）
              key: job.key ?? '',
              // 落盘 ComfyUI 作业号：重启后后台轮询才能接着把这批图取回来。
              // 不存的话，重启后这条作业永远停在 pending，图留在 ComfyUI 里没人认领。
              comfyId: job.comfyId ?? null,
              backend: job.backend ?? 'comfyui', channelId: job.channelId ?? '', channelName: job.channelName ?? '',
              requestStarted: job.requestStarted === true,
              requestMayHaveSucceeded: job.requestMayHaveSucceeded === true,
              providerTaskId: job.providerTaskId ?? '', cancelMayHaveContinued: job.cancelMayHaveContinued === true,
              channelEndpoint: job.channelEndpoint ?? '', comfyEndpoint: job.comfyEndpoint ?? '',
              providerTaskProvider: job.providerTaskProvider ?? '',
              characterSnapshot: job.characterSnapshot ?? null, comfySimple: job.comfySimple ?? null,
              gameId: job.gameId ?? '', turn: job.turn ?? null, textVersion: job.textVersion ?? '',
              imageOutputWarning: job.imageOutputWarning ?? '',
            }
          }
          await writeJsonAtomic(JOBS_STORE, plain)
        } catch { /* 落盘失败不影响生成 */ }
      })
      return jobsWritePromise
    }

    await mkdir(cacheRoot(config), { recursive: true })
    await restoreJobs()

    /** 一次性修复：插件目录里的数据文件如果带着只读属性，去掉它。 */
    async function fixReadonlyOnce() {
      const targets = ['worldbook.json', 'definitions.json', 'config.json', 'jobs-store.json', 'plans-store.json', 'characters.json']
      for (const name of targets) {
        const p = join(ROOT, name)
        try {
          const s = await stat(p)
          if (!(s.mode & 0o200)) {
            await chmod(p, 0o644)
            logger.info?.('dsh-tavern-image: 去掉了 ' + name + ' 的只读属性')
          }
        } catch { /* 文件不存在就跳过 */ }
      }
    }
    await fixReadonlyOnce().catch(() => {})

    async function loadAllWorkflows() {
      const loaded = []
      for (const entry of config.workflows) {
        try {
          const raw = await readJson(join(ROOT, String(entry.file)), null)
          if (!raw) throw new Error('文件不存在')
          if (!['dsh-tavern-image-v1', 'dsh-tavern-comfy-v1'].includes(raw.format)) throw new Error('不是 dsh-tavern-image-v1 格式')
          if (!raw.prompt || !raw.outputNode || !raw.prompt[raw.outputNode]) throw new Error('缺少 prompt 或 outputNode')
          // 补全 bindings：老格式的工作流只绑了正负面，尺寸/步数/CFG/底模/LoRA 都要能读能改。
          // 用自动识别补齐缺的那几类，已有的不动（尊重手工设置）。
          try {
            const auto = detectWorkflow(raw.prompt).bindings
            const b = Object.assign({}, raw.bindings)
            for (const key of ['positive', 'negative', 'seed', 'batch', 'size', 'steps', 'cfg', 'model', 'loras']) {
              const has = Array.isArray(b[key]) ? b[key].length : 0
              const got = Array.isArray(auto[key]) ? auto[key].length : 0
              if (!has && got) b[key] = auto[key]
            }
            raw.bindings = b
          } catch { /* 补不了就算了，用原来的 */ }
          if (!(raw.bindings?.positive ?? []).length) throw new Error('没有 positive 映射，无法替换画面提示词')
          loaded.push({
            id: String(entry.id), label: entry.label || entry.id, match: Array.isArray(entry.match) ? entry.match : [],
            sizes: entry.sizes ?? null, enabled: entry.enabled !== false, file: String(entry.file),
            prompt: raw.prompt, bindings: raw.bindings ?? {}, outputNode: raw.outputNode, digest: raw.digest ?? '',
            summary: workflowSummary(raw), error: null,
          })
        } catch (error) {
          loaded.push({
            id: String(entry.id), label: entry.label || entry.id, match: Array.isArray(entry.match) ? entry.match : [],
            sizes: entry.sizes ?? null, enabled: entry.enabled !== false, file: String(entry.file),
            error: error?.message ?? String(error),
          })
        }
      }
      workflows = loaded
    }
    await loadAllWorkflows()

    if (!config.defaultWorkflow || !workflows.some(wf => wf.id === config.defaultWorkflow && !wf.error)) {
      const first = workflows.find(wf => !wf.error)
      if (first) config.defaultWorkflow = first.id
    }
    logger.info?.(`dsh-tavern-image: ${workflows.filter(wf => !wf.error).length} 份工作流可用，默认 ${config.defaultWorkflow || '（无）'}`)

    const usable = () => workflows.filter(wf => !wf.error && wf.enabled)
    /**
     * 这次出图会用到的 ComfyUI 工作流：指定了就用指定的，否则用默认工作流。
     * 规划、人物宏展开和编译都按它的模型判断提示词写法；不传工作流时只看得到 "comfyui"，
     * 默认工作流是 Z-Image 这类自然语言模型时，人物宏会被展开成 tag，和编译时的写法对不上。
     */
    const styleWorkflow = (cfg = config, id = '') => {
      if (cfg.imageBackend !== 'comfyui' || cfg.comfyMode === 'simple') return null
      return id ? (workflows.find(wf => wf.id === id && !wf.error) ?? null) : (usable().find(wf => wf.id === cfg.defaultWorkflow) ?? null)
    }

    async function comfyJson(pathname, init) {
      const timeoutSignal = AbortSignal.timeout(30000)
      const response = await fetch(`${config.comfyUrl}${pathname}`, {
        ...init,
        headers: Object.assign({}, init?.headers ?? {}, comfyHeaders(config)),
        signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new Error(`ComfyUI ${pathname} → HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`)
        error.statusCode = response.status
        throw error
      }
      return response.json()
    }

    let simpleObjectInfo = null
    let simpleObjectInfoAt = 0
    async function getSimpleObjectInfo(force = false) {
      if (!force && simpleObjectInfo && Date.now() - simpleObjectInfoAt < 15000) return simpleObjectInfo
      const result = await comfyJson('/object_info')
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ComfyUI /object_info 返回格式不正确')
      simpleObjectInfo = result
      simpleObjectInfoAt = Date.now()
      return result
    }

    async function submitToComfy(compiled, job) {
      let result
      try {
        const requestBody = JSON.stringify({ prompt: compiled.prompt, prompt_id: job.comfyId, client_id: randomUUID() })
        diag.recordJob(job?.id, 'comfy-request', { method: 'POST', path: '/prompt', body: diag.text(requestBody) })
        result = await comfyJson('/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          signal: job?.controller?.signal,
        })
        diag.recordJob(job?.id, 'comfy-accepted', { promptId: result?.prompt_id ?? null, number: result?.number ?? null })
      } catch (error) {
        diag.recordJob(job?.id, 'comfy-request-error', { message: String(error?.message ?? error), code: error?.cause?.code ?? null })
        // Node may report localhost's IPv4/IPv6 attempts as an AggregateError.
        // Treat the POST as unsent only when every underlying transport error
        // proves that a connection was never established. Resets/timeouts stay
        // ambiguous because ComfyUI may already have accepted the prompt.
        const codes = []
        let unknownLeaf = false
        const visitCause = (cause, seen = new Set()) => {
          if (!cause || typeof cause !== 'object') { unknownLeaf = true; return }
          if (seen.has(cause)) return
          seen.add(cause)
          if (typeof cause.code === 'string') codes.push(cause.code)
          const children = [ ...(Array.isArray(cause.errors) ? cause.errors : []), ...(cause.cause ? [cause.cause] : []) ]
          if (!children.length && typeof cause.code !== 'string') unknownLeaf = true
          for (const nested of children) visitCause(nested, seen)
        }
        visitCause(error?.cause)
        const definitelyPreConnect = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
        const connectionDefinitelyNotEstablished = codes.length > 0 && !unknownLeaf && codes.every(code => definitelyPreConnect.has(code))
        error.requestMayHaveSucceeded = connectionDefinitelyNotEstablished
          ? false
          : error.statusCode === undefined || error.statusCode >= 500
        throw error
      }
      if (result?.error) {
        const detail = JSON.stringify(result.error).slice(0, 600)
        throw new Error(`ComfyUI 拒绝了这个工作流：${detail}`)
      }
      if (!result?.prompt_id) {
        const error = new Error('ComfyUI 提交响应未返回 prompt_id；请检查 ComfyUI 队列，未自动重试')
        error.requestMayHaveSucceeded = true
        throw error
      }
      return result.prompt_id
    }

    let refreshSeq = Promise.resolve()
    async function refresh(job, options = {}) {
      // The client-selected prompt_id is stored before POST so a lost response
      // can be recovered. Do not query it until submission has settled: an
      // empty queue during an in-flight POST is not evidence of a lost task.
      if (job.submitting === true) return
      // Only an explicit recovery may inspect a locally cancelled task. Keep
      // normal polling cancelled, and never create a new provider request.
      if (job.state === 'cancelled' && options.recoverCancelled === true) {
        if (!(job.comfyId || (job.backend === 'qwen' && job.providerTaskId))) {
          throw new Error('这个渠道没有可查询的平台任务号；请到生图平台检查结果，未重新提交')
        }
        const snapshot = { ...job, state: 'uncertain', controller: new AbortController(), refreshing: null, queryAt: 0 }
        await refresh(snapshot)
        if (job.state !== 'cancelled') return
        if (['done', 'failed'].includes(snapshot.state)) {
          const { controller, refreshing, ...result } = snapshot
          Object.assign(job, result, { cancelMayHaveContinued: false })
        } else {
          job.error = snapshot.error || '平台任务仍未完成；本地保持取消状态，可以稍后重新查询'
        }
        persistJobs()
        return
      }
      if (['done', 'failed', 'cancelled'].includes(job.state)) return
      if (job.backend === 'qwen' && job.state === 'uncertain' && job.providerTaskId) {
        if (job.refreshing) return job.refreshing
        const channel = config.imageChannels.find(item => item.id === job.channelId && item.provider === 'qwen')
        if (!channel || !job.channelEndpoint || channelEndpointOf(channel) !== job.channelEndpoint) {
          job.error = '原 Qwen 渠道地址已变化；请恢复原渠道配置后重查，或到平台手动检查'
          persistJobs()
          return
        }
        const now = Date.now()
        if (now - job.queryAt < config.queryThrottleMs) return
        job.queryAt = now
        job.refreshing = (async () => {
          try {
            const result = await generateImage(structuredClone(channel), {
              positive: job.positive, negative: job.negative,
              width: job.size?.width, height: job.size?.height,
              steps: job.params?.steps, cfg: job.params?.cfg,
            }, {
              resumeTaskId: job.providerTaskId,
              maxImageBytes: config.maxImageBytes,
              onTask: info => { if (info?.taskId) { job.providerTaskId = String(info.taskId); job.providerTaskProvider = String(info.provider || 'qwen'); persistJobs() } },
            })
            if (job.state === 'cancelled') return
            const output = await transcodeImageOutputAsync(result.bytes, result.mediaType, config, { maxOutputBytes: config.maxImageBytes })
            const file = join(cacheRoot(config), `${job.id}.img`)
            await writeFile(file, output.bytes)
            Object.assign(job, { file, mediaType: output.mediaType, byteLength: output.bytes.length, imageOutputWarning: output.warning || '', percent: 100, state: 'done', requestMayHaveSucceeded: false, completedAt: Date.now(), error: '' })
          } catch (error) {
            if (job.state !== 'cancelled') {
              job.state = error?.requestMayHaveSucceeded === false ? 'failed' : 'uncertain'
              job.requestMayHaveSucceeded = job.state === 'uncertain'
              job.error = (error?.message ?? String(error)) + (job.state === 'uncertain' ? '；平台任务仍待确认，未自动重发' : '')
            }
          } finally {
            job.refreshing = null
            persistJobs()
          }
        })()
        return job.refreshing
      }
      // 没有 ComfyUI 作业号的记录（老数据，或提交还没返回就重载了）不能去查：
      // /history/null 会 404，下面的 catch 会把这条作业误判成 failed。
      if (!job.comfyId) return
      if (!job.comfyEndpoint || endpointOf(config.comfyUrl) !== job.comfyEndpoint) {
        job.error = '原 ComfyUI 地址已变化；请恢复原地址后重查，或到平台手动检查'
        persistJobs()
        return
      }
      const now = Date.now()
      if (now - job.queryAt < config.queryThrottleMs) return
      job.queryAt = now
      refreshSeq = refreshSeq.then(async () => {
        if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return
        try {
          let history = null
          try { history = await comfyJson(`/history/${encodeURIComponent(job.comfyId)}`) }
          catch (error) { if (error.statusCode !== 404) throw error }
          const hit = history?.[job.comfyId]
          if (hit) {
            if (hit.status?.status_str === 'error') {
              job.state = 'failed'
              job.requestMayHaveSucceeded = false
              // 把 ComfyUI 返回的具体错误带上（例如显存不足、显卡掉线），不用再去翻控制台。
              const failure = (hit.status?.messages ?? []).find(m => Array.isArray(m) && m[0] === 'execution_error')?.[1] ?? {}
              const detail = [failure.node_type, String(failure.exception_message ?? '').trim()].filter(Boolean).join('：').slice(0, 300)
              const hint = /DEVICE_LOST|OUT_OF_DEVICE_MEMORY|out of memory/i.test(detail) ? '（显卡掉线或显存不足，请重启 ComfyUI）' : ''
              job.error = 'ComfyUI 执行失败' + (detail ? '：' + detail : '，请检查服务器日志与工作流节点') + hint
              blankRetry.delete(job.id)
              logger.warn?.(`dsh-tavern-image: 作业 ${job.id.slice(0, 8)} ${job.error}`)
              return
            }
            if (hit.status?.completed || hit.status?.status_str === 'success') {
              const images = hit.outputs?.[job.outputNode]?.images
              if (!Array.isArray(images) || !images.length) {
                job.state = 'failed'
                job.requestMayHaveSucceeded = false
                job.error = '工作流没有在指定输出节点返回图片'
                blankRetry.delete(job.id)
                return
              }
              const image = images[0]
              const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
              const response = await fetch(`${config.comfyUrl}/view?${params}`, { signal: AbortSignal.timeout(120000), headers: Object.assign({}, comfyHeaders(config)) })
              if (!response.ok) throw new Error(`ComfyUI /view → HTTP ${response.status}`)
              const bytes = Buffer.from(await response.arrayBuffer())
              if (!bytes.byteLength) throw new Error('ComfyUI 返回了空图片')
              if (bytes.byteLength > config.maxImageBytes) throw new Error('图片超过大小上限')
              const sourceType = response.headers.get('content-type')?.split(';')[0] || (/\.jpe?g$/i.test(image.filename) ? 'image/jpeg' : 'image/png')
              // bf16 / fp16 在部分显卡上偶尔数值溢出，ComfyUI 照常返回一张纯黑图。换个种子重画（不改计算精度）。
              if (isBlankImage(bytes)) {
                const retry = blankRetry.get(job.id)
                if (retry && (job.blankRetries ?? 0) < BLANK_RETRIES && !job.controller?.signal?.aborted) {
                  job.blankRetries = (job.blankRetries ?? 0) + 1
                  const prompt = structuredClone(retry.prompt)
                  const seed = randomInt(0, 2 ** 32)
                  for (const b of retry.seedBindings) { const n = prompt[b.node]; if (n && Object.hasOwn(n.inputs ?? {}, b.input)) n.inputs[b.input] = seed }
                  // 只换种子，不改计算精度：显存里还占着 bf16 模型时再切 fp32，Arc B580 实测会显卡掉线（DEVICE_LOST）。
                  logger.warn?.(`dsh-tavern-image: 作业 ${job.id.slice(0, 8)} 出了全黑图，换种子重画（第 ${job.blankRetries} 次）`)
                  diag.recordJob(job.id, 'blank-image-retry', { attempt: job.blankRetries, oldSeed: job.seed, seed })
                  job.seed = seed
                  job.comfyId = randomUUID()
                  job.state = 'pending'
                  job.percent = 0
                  job.comfyId = await submitToComfy({ prompt }, job)
                  try { await persistJobs() } catch {}
                  return
                }
                blankRetry.delete(job.id)
                job.state = 'failed'
                job.requestMayHaveSucceeded = false
                job.error = 'ComfyUI 连续返回全黑图片（多半是 bf16 / fp16 精度溢出）；可以再点重画换个种子。如果经常出现，先重启 ComfyUI；不要在 bf16 模型已加载时切到 fp32 工作流（部分显卡会因此掉线）'
                return
              }
              const signal = job.controller?.signal
              const output = await transcodeImageOutputAsync(bytes, sourceType, config, { maxOutputBytes: config.maxImageBytes, signal })
              if (signal?.aborted || job.state === 'cancelled') return
              job.mediaType = output.mediaType
              job.imageOutputWarning = output.warning || ''
              job.file = join(cacheRoot(config), `${job.id}.img`)
              await writeFile(job.file, output.bytes)
              if (signal?.aborted || job.state === 'cancelled') { await rm(job.file, { force: true }); return }
              job.byteLength = output.bytes.byteLength
              job.percent = 100
              job.state = 'done'
              blankRetry.delete(job.id)
              job.requestMayHaveSucceeded = false
              job.completedAt = Date.now()
              diag.recordJob(job.id, 'job-done', { mediaType: job.mediaType, bytes: job.byteLength, seed: job.seed, durationMs: job.completedAt - job.createdAt })
              if (output.warning) logger.warn?.(`dsh-tavern-image: 作业 ${job.id.slice(0, 8)} ${output.warning}`)
              logger.info?.(`dsh-tavern-image: 作业 ${job.id.slice(0, 8)} 完成（${job.workflowId}，${output.bytes.byteLength} 字节，seed ${job.seed}）`)
              return
            }
          }
          const queue = await comfyJson('/queue')
          const running = Array.isArray(queue?.queue_running) ? queue.queue_running : []
          const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : []
          const position = pending.findIndex(item => Array.isArray(item) && item[1] === job.comfyId)
          if (running.some(item => Array.isArray(item) && item[1] === job.comfyId)) { job.state = 'running'; job.queuePosition = 0; job.requestMayHaveSucceeded = false }
          else if (position >= 0) { job.state = 'pending'; job.queuePosition = position; job.queuedCount = pending.length; job.requestMayHaveSucceeded = false }
          else {
            job.state = 'uncertain'
            job.requestMayHaveSucceeded = true
            job.error = 'ComfyUI 未在历史或队列中确认此作业号；继续只读检查，未自动重试'
          }
        } catch (error) {
          if (job.state !== 'cancelled') {
            job.state = 'uncertain'
            job.requestMayHaveSucceeded = true
            job.error = (error?.message ?? String(error)) + '；不能确认 ComfyUI 是否仍在处理，未自动重试'
          }
        } finally {
          persistJobs()
        }
      }).catch(() => {})
      await refreshSeq
    }

    // ── 后台轮询 ──────────────────────────────────────────────────────
    // refresh() 原来只在"前端来查 /jobs?id="时被动跑一次（handleJobs 里那一处）。
    // 后果：用户一切走画面、刷新界面、或插件重载，就再没人去问 ComfyUI ——
    // 作业永远停在 pending，而图其实已经画好、躺在 ComfyUI 的 output 目录里没人取。
    // 这里补一个后台扫描：每 3 秒把所有"还没结束且知道 ComfyUI 作业号"的作业刷一遍。
    function startJobSweeper() {
      const timer = setInterval(() => {
        for (const job of jobs.values()) {
          if ((job.state === 'pending' || job.state === 'running' || job.state === 'uncertain')
            && (job.comfyId || (job.backend === 'qwen' && job.providerTaskId && job.providerTaskProvider === 'qwen'))) refresh(job).catch(() => {})
        }
      }, 3000)
      return () => clearInterval(timer)
    }
    if (typeof ctx.effect === 'function') ctx.effect(startJobSweeper, 'dsh-tavern-image: job sweeper')
    else startJobSweeper()

    let lastSessionId = ''
    const startingJobs = new Map()
    const settledTurnWaits = new Map()
    const settledTurnWaitControllers = new Set()
    const imageQueue = []
    let imageRunning = 0
    let imageDisposed = false
    if (typeof ctx.effect === 'function') ctx.effect(() => () => {
      imageDisposed = true
      for (const controller of settledTurnWaitControllers) controller.abort(new Error('插件已卸载'))
      settledTurnWaitControllers.clear()
      for (const job of jobs.values()) if (job.backend !== 'comfyui' && ['pending', 'running'].includes(job.state)) job.controller?.abort()
    }, 'dsh-tavern-image: image channels')

    function drainImages() {
      while (!imageDisposed && imageRunning < config.imageConcurrency && imageQueue.length) {
        const { job, channel, compiled, maxImageBytes } = imageQueue.shift()
        if (job.controller.signal.aborted || !jobs.has(job.id)) continue
        imageRunning++
        job.state = 'running'
        job.requestStarted = true
        persistJobs()
        ;(async () => {
          try {
            const result = await generateImage(channel, {
              positive: compiled.positive, negative: compiled.negative, seed: compiled.seed,
              width: compiled.size.width, height: compiled.size.height, steps: job.params.steps, cfg: job.params.cfg,
            }, { signal: job.controller.signal, maxImageBytes, onTask: info => {
              if (info?.provider && info?.taskId) {
                job.providerTaskId = String(info.taskId)
                job.providerTaskProvider = String(info.provider)
                persistJobs()
              }
            } })
            job.controller.signal.throwIfAborted()
            if (!jobs.has(job.id)) return
            const output = await transcodeImageOutputAsync(result.bytes, result.mediaType, config, { maxOutputBytes: maxImageBytes, signal: job.controller.signal })
            job.controller.signal.throwIfAborted()
            const file = join(cacheRoot(config), `${job.id}.img`)
            await writeFile(file, output.bytes)
            if (job.controller.signal.aborted || !jobs.has(job.id)) { await rm(file, { force: true }); return }
            Object.assign(job, { file, mediaType: output.mediaType, byteLength: output.bytes.length, imageOutputWarning: output.warning || '', percent: 100, state: 'done', completedAt: Date.now() })
            if (output.warning) logger.warn?.(`dsh-tavern-image: 作业 ${job.id.slice(0, 8)} ${output.warning}`)
          } catch (error) {
            job.requestMayHaveSucceeded = error.requestMayHaveSucceeded === true
            if (job.controller.signal.aborted) {
              job.state = 'cancelled'
              job.cancelMayHaveContinued = job.requestStarted === true
              job.error = job.cancelMayHaveContinued ? '本地已停止等待；平台请求可能已提交，仍可能继续生成并产生费用' : '已取消'
            }
            else {
              job.state = job.requestMayHaveSucceeded ? 'uncertain' : 'failed'
              job.error = (error?.message ?? '生图渠道请求失败') + (job.requestMayHaveSucceeded ? '；平台可能已接单，请先检查任务，未自动重试' : '')
            }
          } finally {
            imageRunning--
            persistJobs()
            drainImages()
          }
        })()
      }
    }

    function startJob(rawParams, options = {}) {
      const key = typeof rawParams?.key === 'string' ? rawParams.key.slice(0, 4000) : ''
      if (key && startingJobs.has(key)) return startingJobs.get(key)
      const pending = createJob(rawParams, options)
      if (key) {
        startingJobs.set(key, pending)
        pending.finally(() => { if (startingJobs.get(key) === pending) startingJobs.delete(key) }).catch(() => {})
      }
      return pending
    }

    async function createJob(rawParams, { label = '', forceWorkflow = null, jobConfig = config, diagTrace = null } = {}) {
      // 浏览器半边只传 tag 和 key，其余（画师串、画幅）由控制台配置兜底。
      const params = {
        tag: String(rawParams?.tag ?? ''),
        // 展开前的原始提示词（含 ${...}$ 宏），编辑器里显示这个 —— 一眼能看出调用了谁
        rawTag: String(rawParams?.rawTag ?? rawParams?.tag ?? ''),
        artist: rawParams?.artist ? String(rawParams.artist) : activeArtistText(jobConfig).text,
        artistPosition: rawParams?.artistPosition ?? (rawParams?.artist ? undefined : activeArtistText(jobConfig).position),
        negative: String(rawParams?.negative ?? ''),
        size: String(rawParams?.size || jobConfig.imageSize || '竖图'),
        model: String(rawParams?.model ?? ''),
        textVersion: String(rawParams?.textVersion ?? ''),
        steps: rawParams?.steps,
        cfg: rawParams?.cfg,
      }
      if (rawParams?.sessionId) lastSessionId = String(rawParams.sessionId)
      const key = typeof rawParams?.key === 'string' ? rawParams.key.slice(0, 4000) : ''
      if (key) {
        const existing = findJob(key)
        if (existing?.state === 'uncertain' || (existing?.state === 'cancelled' && existing.requestMayHaveSucceeded)) {
          throw new Error('同一请求的作业状态仍不确定；请先检查生图平台，未自动重试')
        }
        if (existing && (existing.state === 'pending' || existing.state === 'running' || existing.state === 'done')) return publicJob(existing)
      }
      const channel = forceWorkflow ? null : channelWithPresetParams(jobConfig)
      let workflow = forceWorkflow || (!channel && jobConfig.comfyMode === 'simple' ? null : (!channel ? pickWorkflow(usable(), jobConfig, params.model) : null))
      let simpleBuild = null
      if (!channel && !forceWorkflow && jobConfig.comfyMode === 'simple') {
        simpleBuild = buildComfySimpleWorkflow(jobConfig.comfySimple, await getSimpleObjectInfo())
        workflow = simpleBuild.workflow
        // Simple mode owns its dimensions. Keep the old default size dropdown from rewriting them.
        params.size = `${simpleBuild.config.width}x${simpleBuild.config.height}`
      }
      if (!channel && !workflow) throw new Error('没有可用的工作流（检查控制台「画风」页）')
      const defsForTurn = applyCharacterSnapshot(definitions, rawParams?.characterSnapshot)
      const card = await currentCard(rawParams?.sessionId || lastSessionId, rawParams?.turn)
      const scopedDefs = card
        ? { ...defsForTurn, characters: (defsForTurn.characters ?? []).filter(character => usableOnCard(character, card)) }
        : defsForTurn
        // 这里可以打日志（runtime 里能拿到 logger）
      const compileConfig = forceWorkflow
        ? { ...jobConfig, imageBackend: 'comfyui', comfyMode: 'workflow' }
        : (simpleBuild ? { ...jobConfig, overrideSteps: false } : jobConfig)
      const traceStages = diagTrace?.traceId ? [] : null
      const onStage = traceStages ? (name, data) => traceStages.push({ name, data }) : null
      const compiled = workflow ? compileJob({ workflow, params, config: compileConfig, definitions: scopedDefs, onStage })
        : compileChannelJob({ params, config: jobConfig, definitions: scopedDefs, onStage })
      if (traceStages) {
        const T = diag.text
        const at = { imageIndex: diagTrace.imageIndex }
        diag.record(diagTrace.traceId, 'job-input', { tag: T(params.tag), rawTag: T(params.rawTag), artist: T(params.artist), artistPosition: params.artistPosition, negative: T(params.negative), size: params.size, workflowId: workflow?.id ?? '', channel: channel?.provider ?? '', definitionsAppliedFromSnapshot: Boolean(rawParams?.characterSnapshot), scopedCharacterIds: (scopedDefs.characters ?? []).map(c => String(c.id ?? '')) }, at)
        for (const item of traceStages) {
          const shaped = {}
          for (const [k, v] of Object.entries(item.data ?? {})) shaped[k] = typeof v === 'string' ? T(v) : (k === 'provenance' && Array.isArray(v) ? v.map(o => ({ ...o, text: T(o.text) })) : v)
          diag.record(diagTrace.traceId, item.name, shaped, at)
        }
        diag.record(diagTrace.traceId, 'compiled', { positive: T(compiled.positive), negative: T(compiled.negative), seed: compiled.seed, size: compiled.size, hits: compiled.hits, loras: compiled.loras, workflowPrompt: compiled.prompt ? T(JSON.stringify(compiled.prompt)) : null }, at)
      }

      // 这里在 runtime 内，可以打日志
      if (compiled?.loras?.length) {
        logger.info?.('dsh-tavern-image: 本张用了 ' + compiled.loras.length + ' 个 LoRA：' +
          compiled.loras.map(x => x.name + (x.off ? '(关)' : '(' + (Number.isFinite(x.model) ? x.model : 1) + ')')).join('、'))
      }
      const control = new AbortController()
      const job = {
        id: randomUUID(), comfyId: channel ? null : randomUUID(), workflowId: workflow?.id ?? '', outputNode: workflow?.outputNode,
        backend: channel?.provider ?? 'comfyui', channelId: channel?.id ?? '', channelName: channel?.name ?? '',
        channelEndpoint: channel ? channelEndpointOf(channel) : '', comfyEndpoint: endpointOf(jobConfig.comfyUrl),
        state: 'pending', percent: 0, seed: compiled.seed, createdAt: Date.now(), queryAt: 0, requestStarted: false,
        params: { ...params }, key, size: compiled.size, hits: compiled.hits,
        characterSnapshot: rawParams?.characterSnapshot ? boundCharacterSnapshot(rawParams.characterSnapshot) : null,
        comfySimple: channel ? null : structuredClone(jobConfig.comfySimple ?? null),
        gameId: String(rawParams?.sessionId ?? ''), turn: Number(rawParams?.turn) || null, textVersion: String(rawParams?.textVersion ?? ''),
        // 记住这张用了哪些 LoRA —— 事后在历史里能查
        loras: Array.isArray(compiled.loras) ? compiled.loras : [],
        positive: compiled.positive, negative: compiled.negative, label, controller: control,
      }
      jobs.set(job.id, job)
      if (diagTrace?.traceId) { diag.bindJob(job.id, diagTrace.traceId, diagTrace.imageIndex); diag.recordJob(job.id, 'job-created', { comfyId: job.comfyId, backend: job.backend, workflowId: job.workflowId, gameIdHash: job.gameId ? diag.text(job.gameId) : null, turn: job.turn, textVersion: job.textVersion }) }
    try { persistJobs() } catch {}
      if (key) byKey.set(key, job.id)
      if (channel) {
        imageQueue.push({ job, channel, compiled, maxImageBytes: jobConfig.maxImageBytes })
        drainImages()
        sweep()
        return publicJob(job)
      }
      try {
        job.submitting = true
        job.requestStarted = true
        await persistJobs()
        if (compiled?.prompt) blankRetry.set(job.id, { prompt: compiled.prompt, seedBindings: workflow?.bindings?.seed ?? [] })
        job.comfyId = await submitToComfy(compiled, job)
        if (job.controller.signal.aborted || job.state === 'cancelled') {
          job.state = 'cancelled'
          job.cancelMayHaveContinued = true
          job.error = '本地已停止等待；ComfyUI 中已提交的任务仍可能继续生成'
        } else {
          job.requestMayHaveSucceeded = false
        }
        logger.info?.(`dsh-tavern-image: 已提交 ${job.id.slice(0, 8)}（${workflow.id}${compiled.size ? `，${compiled.size.width}x${compiled.size.height}` : ''}，seed ${compiled.seed}${compiled.hits.length ? `，人物库 ${compiled.hits.join('/')}` : ''}）`)
      } catch (error) {
        job.requestMayHaveSucceeded = error.requestMayHaveSucceeded === true
        if (job.controller.signal.aborted || job.state === 'cancelled') {
          job.state = 'cancelled'
          job.cancelMayHaveContinued = job.requestMayHaveSucceeded || job.requestStarted
          job.error = job.cancelMayHaveContinued ? '本地已停止等待；ComfyUI 请求可能已提交，任务仍可能继续生成' : '已取消'
        } else {
          job.state = job.requestMayHaveSucceeded ? 'uncertain' : 'failed'
          job.error = (error?.message ?? String(error)) + (job.requestMayHaveSucceeded ? '；请在 ComfyUI 检查任务，未自动重试' : '')
        }
        logger.error?.(`dsh-tavern-image: 提交${job.state === 'uncertain' ? '结果不确定' : '失败'} ${job.id.slice(0, 8)}：${job.error}`)
      } finally {
        job.submitting = false
      }
      // 提交返回后的 ComfyUI 作业号也要保存，重载后后台扫描才能认领队列结果。
      persistJobs()
      sweep()
      return publicJob(job)
    }

    function findJob(key) {
      if (!key) return null
      const id = byKey.get(key)
      return id ? jobs.get(id) ?? null : null
    }

    function getJob(id) { return jobs.get(id) ?? null }

    function replacementConfigFor(source, requestedChannelId) {
      const next = structuredClone(config)
      const requested = requestedChannelId === undefined || requestedChannelId === null || requestedChannelId === ''
        ? (source.backend === 'comfyui' ? 'comfyui' : String(source.channelId || ''))
        : String(requestedChannelId)
      if (requested === 'comfyui') {
        next.imageBackend = 'comfyui'
        next.activeImageChannel = ''
        return next
      }
      const channel = next.imageChannels.find(item => item.id === requested)
      if (!channel) throw Object.assign(new Error('所选生图渠道已不存在，请重新选择渠道'), { submissionNotStarted: true })
      next.imageBackend = channel.provider
      next.activeImageChannel = channel.id
      return next
    }

    async function startReplacement({ sourceJobId, prompt, negative, channelId, sessionId, turn, textVersion } = {}) {
      const source = getJob(String(sourceJobId || ''))
      if (!source) throw Object.assign(new Error('找不到这张图片的源作业'), { submissionNotStarted: true })
      if (source.state === 'uncertain' || source.cancelMayHaveContinued
        || (source.requestMayHaveSucceeded && !['done', 'failed'].includes(source.state))) {
        throw Object.assign(new Error('原作业结果未知；请先检查生图平台，不能安全地重绘'), { code: 'UNCERTAIN', submissionNotStarted: true })
      }
      const jobConfig = replacementConfigFor(source, channelId)
      const session = String(sessionId || '')
      const rawTag = String(prompt ?? source.params?.rawTag ?? source.params?.tag ?? '')
      if (!rawTag.trim()) throw Object.assign(new Error('原作业没有可用提示词'), { submissionNotStarted: true })
      const sourceContextMatches = source.gameId === session && Number(source.turn) === Number(turn) && source.textVersion === textVersion
      let characterSnapshot = sourceContextMatches ? source.characterSnapshot : null
      if (!characterSnapshot && textVersion && typeof deps.tavern?.readTurnData === 'function') {
        try {
          const saved = await deps.tavern.readTurnData({ gameId: session, turn: Number(turn) })
          if (saved?.textVersion === textVersion && saved?.data) characterSnapshot = saved.data
        } catch {}
      }
      let card
      try { card = await currentCard(session, turn) }
      catch (error) { error.submissionNotStarted = true; throw error }
      const defs = applyCharacterSnapshot(definitions, characterSnapshot)
      const scoped = card ? { ...defs, characters: (defs.characters ?? []).filter(character => usableOnCard(character, card)) } : defs
      const keepComfySource = source.backend === 'comfyui' && jobConfig.imageBackend === 'comfyui'
      const simpleTemplate = source.comfySimple?.template
      const isSimpleSource = ['checkpoint', 'flux', 'anima'].includes(simpleTemplate) && source.workflowId === `simple-${simpleTemplate}`
      if (keepComfySource && isSimpleSource) {
        jobConfig.comfyMode = 'simple'
        jobConfig.comfySimple = structuredClone(source.comfySimple)
      }
      const workflow = keepComfySource && !isSimpleSource ? workflows.find(item => item.id === source.workflowId && !item.error) : null
      if (keepComfySource && source.workflowId?.startsWith('simple-') && !isSimpleSource) {
        throw Object.assign(new Error('原简单工作流快照不可用；请检查原始 ComfyUI 模板配置'), { submissionNotStarted: true })
      }
      if (keepComfySource && source.workflowId && !isSimpleSource && !workflow) {
        throw Object.assign(new Error('原 ComfyUI 工作流已不存在；请在控制台选择其他渠道后重绘'), { submissionNotStarted: true })
      }
      if (keepComfySource && workflow) jobConfig.comfyMode = 'workflow'
      let fresh
      try {
        fresh = await startJob({
          tag: normalizePrompts(expandRosterCalls(rawTag, scoped, jobConfig.traitMode, { style: rosterStyle(jobConfig, workflow ?? styleWorkflow(jobConfig)) }), scoped, { backend: jobConfig.imageBackend, style: rosterStyle(jobConfig, workflow ?? styleWorkflow(jobConfig)) }),
          rawTag,
          artist: source.params?.artist,
          artistPosition: source.params?.artistPosition,
          negative: String(negative ?? source.params?.negative ?? ''),
          size: source.params?.size,
          model: workflow ? workflow.id : source.params?.model || '',
          steps: source.params?.steps,
          cfg: source.params?.cfg,
          characterSnapshot,
          textVersion,
          sessionId: session, turn,
          key: 'media-replacement:' + randomUUID(),
        }, { label: '单图重绘', jobConfig, forceWorkflow: workflow || null })
      } catch (error) {
        if (error.requestMayHaveSucceeded !== true) error.submissionNotStarted = true
        throw error
      }
      return { jobId: fresh.id }
    }

    function cancelJob(id) {
      const job = getJob(String(id || ''))
      if (!job) return null
      if (['done', 'failed', 'cancelled'].includes(job.state)) return publicJob(job)
      if (job.backend !== 'comfyui' && job.state === 'pending' && job.requestStarted !== true) {
        for (let i = imageQueue.length - 1; i >= 0; i--) if (imageQueue[i].job.id === job.id) imageQueue.splice(i, 1)
        job.controller?.abort(new Error('用户取消排队中的图片'))
        job.state = 'cancelled'
        job.requestMayHaveSucceeded = false
        job.error = '已取消；图片仍在本地排队中时没有提交到平台'
        persistJobs()
        return publicJob(job)
      }
      const requestStarted = job.requestStarted === true
      job.controller?.abort(new Error('用户停止此图片的本地等待'))
      job.state = 'cancelled'
      job.cancelMayHaveContinued = requestStarted || job.backend === 'comfyui'
      job.error = job.cancelMayHaveContinued
        ? (job.backend === 'comfyui' ? '本地已停止追踪；ComfyUI 中已提交的任务仍可能继续生成' : '本地已停止等待；平台请求可能已提交，仍可能继续生成并产生费用')
        : '已取消'
      persistJobs()
      return publicJob(job)
    }

    // ---- 生图规划：agent 生图 ----
    // 规划默认跟随 Tavern 的「默认后台模型」（和 MVU 结算共用一套配置）；
    // 控制台里填了 provider/model 就用填的那个。
    //
    // 这里以前是直接读 data/tavern-settings.json 里的 defaultBackgroundModel。
    // 现在走官方接口 tavern.backgroundModel({ gameId }) —— 不碰 Tavern 的数据文件，
    // Tavern 以后调整存储结构也不会影响这里。
    async function backgroundModel(gameId) {
      const id = String(gameId ?? '').trim()
      if (!id) return null
      if (!deps.tavern || typeof deps.tavern.backgroundModel !== 'function') return null
      try {
        const picked = await deps.tavern.backgroundModel({ gameId: id })
        if (picked && picked.provider && picked.model) {
          // Tavern 3.0（插件接口第 3 版）起还会给出这局设置的后台推理强度；旧版没有这个字段。
          const effort = typeof picked.reasoningEffort === 'string' ? picked.reasoningEffort.trim() : ''
          return { provider: String(picked.provider), model: String(picked.model), ...(effort ? { reasoningEffort: effort } : {}), source: 'tavern' }
        }
      } catch { /* 拿不到就当没有，让调用方去用插件自己配的模型 */ }
      return null
    }
    /**
     * 规划用的推理强度：插件里单独设置了就用插件的；没设置、并且模型也跟随 Tavern 后台模型时，
     * 沿用这局 Tavern 设置的后台推理强度（推理强度的取值和模型绑定，换了模型就不能沿用）。
     */
    const plannerEffortFor = fallback => String(config.plannerEffort || (!config.plannerModel && fallback?.reasoningEffort) || '') || undefined

    // ---- 当前会话用的是哪张卡（角色可以按卡过滤）----
    //
    // 这里以前是遍历 data/resources/.tavern/sessions/*/context.json 去找卡。
    // 现在只用官方接口给的东西：onTurnSettled / getTurn 的回调里本来就带
    // card: { id, name }，每轮结算时顺手记下来就够了 —— 每一轮都会刷新它，
    // 所以「当前卡」总是跟着最新一轮走，不用自己去翻别人的会话目录。
    const cardCache = new Map()   // gameId → { path, name }
    const lastTurn = new Map()    // gameId → 最近一轮的轮次号

    /** 记住一轮的卡与轮次（tavern-bridge 在每轮结算时调用）。 */
    function rememberTurn(gameId, turn, card) {
      const id = String(gameId ?? '').trim()
      if (!id) return
      const t = Number(turn)
      if (Number.isSafeInteger(t) && t > 0) lastTurn.set(id, t)
      if (card && (card.id || card.name)) {
        cardCache.set(id, { path: String(card.id ?? ''), name: String(card.name ?? '') })
      }
      // 只留最近的会话，换卡很频繁时不会一直涨
      if (cardCache.size > 30) {
        for (const k of cardCache.keys()) { cardCache.delete(k); if (cardCache.size <= 20) break }
      }
    }
    // 挂到 deps 上再给外面用：installTavernBridge 是在 createRuntime **之外**装配的
    // （ctx.inject 的回调里），那边直接引用这个函数会是 ReferenceError，而且会被
    // bridge 的 try/catch 静默吞掉 —— 表现成「功能不工作但没有任何报错」。
    deps.rememberTurn = rememberTurn

    /** Timeline events invalidate stale card/turn observations; a supplied turn is the only safe new anchor. */
    function rememberTimeline(event) {
      const id = String(event?.gameId ?? '').trim()
      if (!id) return
      cardCache.delete(id)
      lastTurn.delete(id)
      const turn = Number(event?.turn)
      if (Number.isSafeInteger(turn) && turn > 0) lastTurn.set(id, turn)
    }
    deps.rememberTimeline = rememberTimeline

    /** 拿这一轮（不传就用最近一轮）的卡；只认官方接口，拿不到就返回 null。 */
    async function currentCard(sessionId, turn) {
      const id = String(sessionId ?? '').trim()
      if (!id) return null
      const want = Number(turn)
      const known = lastTurn.get(id)
      // 没要求换一轮时，缓存就够用（省掉一次 getTurn）
      if (!(Number.isSafeInteger(want) && want > 0 && want !== known)) {
        const cached = cardCache.get(id)
        if (cached) return cached
      }
      const target = (Number.isSafeInteger(want) && want > 0) ? want : known
      if (target && deps.tavern && typeof deps.tavern.getTurn === 'function') {
        try {
          const snapshot = await deps.tavern.getTurn({ gameId: id, turn: target })
          if (snapshot?.card && (snapshot.card.id || snapshot.card.name)) {
            const found = { path: String(snapshot.card.id ?? ''), name: String(snapshot.card.name ?? '') }
            cardCache.set(id, found)
            return found
          }
        } catch { /* 这一轮拿不到就退回缓存 */ }
      }
      return cardCache.get(id) ?? null
    }

    /** 这个角色在这张卡下可用吗（没绑卡的全局角色一直可用）。 */
    function usableOnCard(character, card) {
      const cards = character.cards ?? []
      if (!cards.length) return true
      // 拿不到"当前卡"时不过滤 —— 否则绑过卡的角色会全军覆没（曾经因此整库失效）
      if (!card) return true
      const path = String(card.path ?? '')
      const name = String(card.name ?? '')
      const bare = path.replace(/^.*\//, '').replace(/\.json$/i, '')
      return cards.some(entry => {
        if (!entry) return false
        const e = String(entry)
        const eBare = e.replace(/^.*\//, '').replace(/\.json$/i, '')
        if (path.endsWith(e) || e.endsWith(path) || path.includes(e) || e.includes(path)) return true
        // 卡名匹配：会话里的 name 和绑定项里的文件名算同一个人
        // （例如会话叫《某卡》，绑定项写的是《某卡_MVU版本》）
        if (name && (name === e || eBare === name || eBare.includes(name) || name.includes(eBare))) return true
        if (bare && (bare === e || eBare === bare || eBare.includes(bare) || bare.includes(eBare))) return true
        return false
      })
    }

    /**
     * 当前卡的设定 + 这一轮真正绑定的世界书条目 —— 走 Tavern 官方接口。
     *
     * 这里以前是自己读卡文件（readCardData）+ 拿正文去**猜**哪几条世界书该命中
     * （关键词包含 + 常驻标记），还要自己剥托管格式的两层包装。
     * 现在交给 tavern.getCardContext({ gameId, turn })：
     *   · description / personality / scenario 已经做过度宏投影
     *   · lore 是 Tavern 自己按这一轮算出来的绑定结果
     * 比插件手写的关键词匹配准，而且不碰用户的任何卡片文件。
     *
     * 拿不到轮次（比如刚从控制台点进来、这一局还没聊过）就返回 null。
     */
    async function cardContextRaw(sessionId, turn) {
      const id = String(sessionId ?? '').trim()
      if (!id || !deps.tavern || typeof deps.tavern.getCardContext !== 'function') return null
      const want = Number(turn)
      const target = (Number.isSafeInteger(want) && want > 0) ? want : lastTurn.get(id)
      if (!target) return null
      try { return await deps.tavern.getCardContext({ gameId: id, turn: target }) } catch { return null }
    }

    // 世界书的写操作排队执行：调试时每次按键都会触发保存，串起来就不会互相 rename 撞车
    let worldbookWriteChain = Promise.resolve()
    function queueWorldbookWrite(task) {
      const next = worldbookWriteChain.then(task, task)
      worldbookWriteChain = next.catch(() => {})
      return next
    }

    /** 读世界书文件（保留 enabled 标记），返回 { name, entries }。 */
    // 两本世界书并列，互不覆盖：
//   1. 生图规则      worldbook.json         ← 种子 世界书-通用生图规则.json
//   2. 角色与服装库  worldbook-outfits.json ← 种子 世界书-角色与服装库.json
// 每本各自独立落盘、独立编辑；加载时按固定顺序合并进同一份提示词。
const WORLD_BOOKS = [
  { data: 'worldbook.json', seed: '世界书-通用生图规则.json', label: '生图规则', fallbackName: '生图世界书' },
  { data: 'worldbook-outfits.json', seed: '世界书-角色与服装库.json', label: '角色与服装库', fallbackName: '角色与服装库' },
]

async function loadOneWorldbook(book) {
  let raw = await readJson(join(ROOT, book.data), null)
  // 首次运行：这两个文件都是使用者自己的数据，不进公开仓库。
  // 仓库各带一份种子 —— 只在对应文件不存在时生成一次，之后永不覆盖。
  if (!raw) {
    const seed = await readJson(join(ROOT, book.seed), null)
    const seeded = seed ? normalizeWorldbook(seed) : null
    if (seeded && seeded.entries.length) {
      raw = seeded
      try {
        await writeJsonSafe(join(ROOT, book.data), seeded, join(ROOT, 'backups'))
        logger.info?.('dsh-tavern-image: 首次运行，已用种子生成「' + book.label + '」（' + seeded.entries.length + ' 条）')
      } catch (error) {
        logger.warn?.('dsh-tavern-image: 「' + book.label + '」落盘失败 ' + (error?.message ?? error))
      }
    }
  }
  const norm = raw ? normalizeWorldbook(raw) : null
  return norm ?? { name: book.fallbackName, entries: [] }
}

async function loadWorldbook() {
  const loaded = []
  for (const book of WORLD_BOOKS) {
    try {
      const one = await loadOneWorldbook(book)
      loaded.push({ label: book.label, name: one.name, entries: one.entries })
    } catch (error) {
      // 单本坏掉不能连累另一本，也不能连累生图。
      logger.warn?.('dsh-tavern-image: 世界书「' + book.label + '」加载失败：' + (error?.message ?? error))
    }
  }
  if (!loaded.length) return { name: '生图世界书', entries: [] }
  const entries = []
  for (const book of loaded) for (const entry of book.entries) entries.push(entry)
  return {
    name: loaded[0].name,
    entries,
    // 便于 /state 与前端区分两本，并显示各自条数
    books: loaded.map(book => ({ label: book.label, name: book.name, count: book.entries.length })),
  }
}

    /**
 * 按「本」读写（编辑用）。
 * loadWorldbook() 是给提示词用的合并视图；编辑必须落到某一本上，
 * 否则改第二本的条目时会把合并结果写回第一本，两本互相污染。
 */
const BOOK_KEYS = { main: 'worldbook.json', outfits: 'worldbook-outfits.json' }
const BOOK_SEEDS = { main: '世界书-通用生图规则.json', outfits: '世界书-角色与服装库.json' }

function normalizeBookKey(key) {
  const k = String(key ?? '').trim()
  return Object.prototype.hasOwnProperty.call(BOOK_KEYS, k) ? k : 'main'
}

/** 读某一本（不含合并），文件不存在时用对应种子兜底。 */
async function loadOneBook(key) {
  const bookKey = normalizeBookKey(key)
  const raw = await readJson(join(ROOT, BOOK_KEYS[bookKey]), null)
  if (raw) return normalizeWorldbook(raw) ?? { name: BOOK_KEYS[bookKey], entries: [] }
  const seed = await readJson(join(ROOT, BOOK_SEEDS[bookKey]), null)
  const seeded = seed ? normalizeWorldbook(seed) : null
  return seeded ?? { name: BOOK_KEYS[bookKey], entries: [] }
}

/** 写某一本，并清掉合并缓存。 */
async function saveOneBook(key, doc) {
  const bookKey = normalizeBookKey(key)
  await writeJsonSafe(join(ROOT, BOOK_KEYS[bookKey]), doc, join(ROOT, 'backups'))
  worldbookCache = null
  return doc
}

/** 两本各自的摘要 + 条目正文，随 /state 给前端做书选择器与折叠列表。 */
async function worldbookBookIndex() {
  const out = []
  for (const key of Object.keys(BOOK_KEYS)) {
    try {
      const one = await loadOneBook(key)
      out.push({
        key,
        file: BOOK_KEYS[key],
        seed: BOOK_SEEDS[key],
        name: one.name,
        count: one.entries.length,
        enabled: one.entries.filter(entry => entry.enabled !== false).length,
        entries: one.entries.map((entry, index) => ({
          index,
          comment: String(entry.comment ?? ''),
          content: String(entry.content ?? ''),
          enabled: entry.enabled !== false,
          activation: entry.activation === 'keywords' ? 'keywords' : 'always',
          keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
        })),
      })
    } catch (error) {
      out.push({ key, file: BOOK_KEYS[key], name: '', count: 0, enabled: 0, entries: [], error: String(error?.message ?? error) })
    }
  }
  return out
}

let worldbookCache = null
    let lastPlannerContext = null
    async function worldbook() {
      if (!worldbookCache) {
        const wb = await loadWorldbook()
        // 统一成 worldbookEntries 的形状（index / comment / content / length）
        worldbookCache = wb.entries.map((e, index) => ({
          index, comment: e.comment, content: e.content, length: e.content.length,
          enabled: e.enabled !== false,
          ...normalizeEntryActivation(e),
        }))
      }
      return worldbookCache
    }

    const plansByMessage = new Map()
    // 计划落盘：重启 DSH 之后已经生成过的插图位置还能恢复
    const PLANS_STORE = join(ROOT, 'plans-store.json')
    try {
      const saved = await readJson(PLANS_STORE, null)
      if (saved && typeof saved === 'object') {
        for (const [key, value] of Object.entries(saved)) plansByMessage.set(key, value)
        logger.info?.('dsh-tavern-image: 恢复了 ' + plansByMessage.size + ' 条插图计划')
      }
    } catch { /* 读不到就当没有 */ }
    // 串行写盘：写完一条再写下一条，进程退出前也能落住（之前用 setTimeout 延迟写，结果文件根本没生成）
    let plansWriteChain = Promise.resolve()
    let plansDirty = false
    function persistPlans() {
      plansDirty = true
      plansWriteChain = plansWriteChain.then(async () => {
        if (!plansDirty) return
        plansDirty = false
        try {
          const entries = [...plansByMessage.entries()]
            .filter(([, value]) => value && Array.isArray(value.plans) && value.plans.length)
            .slice(-80)
          await writeJsonAtomic(PLANS_STORE, Object.fromEntries(entries))
          logger.info?.('dsh-tavern-image: 插图计划已落盘（' + entries.length + ' 条）')
        } catch (error) {
          logger.warn?.('dsh-tavern-image: 插图计划落盘失败 ' + (error?.message ?? error))
        }
      })
      return plansWriteChain
    }

    // ---- 后台任务表：让界面看得见"正在后台跑什么"，并且能取消 ----
    // 浏览器半边发回来的执行报告（诊断用：前端到底跑没跑、错在哪）
    const clientReports = []
    // 高频上报（每条消息渲染都会来一次）不写日志，只在有意义的阶段写
    const QUIET_STAGES = new Set(['renderer-takeover', 'host-plans-query', 'bundle-evaluated', 'seat-registered'])
    function addClientReport(entry) {
      const stage = String(entry?.stage ?? '')
      const isFail = /-fail$/.test(stage)
      clientReports.push(entry)
      if (clientReports.length > 80) clientReports.shift()
      // 失败类永远写日志（不受高频静音影响，也不怕被 80 条上限挤掉）
      if (isFail) {
        logger.warn?.('dsh-tavern-image: [client-fail] ' + stage + ' ' + JSON.stringify(entry.data ?? {}).slice(0, 900))
        return
      }
      if (QUIET_STAGES.has(stage)) return
      logger.info?.('dsh-tavern-image: [client] ' + stage + ' ' + JSON.stringify(entry.data ?? {}).slice(0, 400))
    }

    const tasks = new Map()
    function beginTask(kind, label) {
      const task = { id: randomUUID(), kind, label, startedAt: Date.now(), state: 'running', controller: new AbortController() }
      tasks.set(task.id, task)
      if (tasks.size > 40) {
        for (const [id, item] of tasks) {
          if (tasks.size <= 40) break
          if (item.state !== 'running') tasks.delete(id)
        }
      }
      return task
    }
    function finishTask(task, error) {
      if (task.state === 'cancelled') return
      task.state = error ? 'failed' : 'done'
      task.error = error ? String(error?.message ?? error) : ''
      task.finishedAt = Date.now()
    }
    function cancelTask(id) {
      const task = tasks.get(String(id))
      if (!task || task.state !== 'running') return false
      task.state = 'cancelled'
      task.error = '已取消'
      task.finishedAt = Date.now()
      try { task.controller.abort(new Error('用户取消')) } catch {}
      return true
    }
    function publicTasks() {
      return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(task => ({
        id: task.id, kind: task.kind, label: task.label, state: task.state,
        startedAt: task.startedAt, finishedAt: task.finishedAt ?? null, error: task.error ?? '',
      }))
    }

    async function planMessage({ text, messageId, turn, textVersion, count, sessionId, manual, force, smartSelection, imageGeneration = true, characterUpdates = false, historySnapshot, signal, onPlan, reusePlan }) {
      signal?.throwIfAborted()
      if (config.plannerEnabled === false && !manual && !characterUpdates) throw new Error('生图规划没打开（控制台 → 高级设置）')
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务，无法做生图规划')
      const fallback = await backgroundModel(sessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      const plannerEffort = plannerEffortFor(fallback)
      if (!provider || !model) throw new Error('规划用的模型没定：Tavern 设置里的「默认后台模型」是空的，或者在本插件设置里单独指定一个')
      const body = String(text ?? '').trim()
      if (!body) throw new Error('正文是空的')

      const entries = await worldbook()
      const card = await currentCard(sessionId, turn)
      const timelineDefinitions = applyCharacterSnapshot(definitions, historySnapshot)
      let visualSnapshot = historySnapshot ?? emptyCharacterSnapshot()
      const scoped = {
        ...timelineDefinitions,
        characters: (timelineDefinitions.characters ?? []).filter(character => usableOnCard(character, card)),
      }
      // 世界书条目的 backends 里可以写 tags / natural / mixed，按默认工作流的写法只给规划看对应的规则。
      const plannerWorkflow = styleWorkflow()
      const plannerMode = resolvePromptMode(config, promptBackendContext(config, plannerWorkflow))
      const plannerContext = selectPlannerContext({
        entries, selected: config.plannerEntries, text: body, definitions: scoped,
        backend: config.imageBackend, promptMode: plannerMode, characterUpdates,
      })
      const roster = characterRoster(plannerContext.definitions, { fullTraits: characterUpdates, text: body })
      const want = imageGeneration ? Math.max(1, Math.min(8, Number(count) || config.plannerCount || 3)) : 0
      const smart = Boolean(imageGeneration && smartSelection && !force)
      // 生图只依赖两样：正文本身，和「生成图片的世界书」+ 人物库。
      // 卡片自己的世界书是给叙事用的（NPC生成/宗门生成那类规则），掺进画面提示词只会带偏。
      const guidanceWorkflow = config.imageBackend === 'comfyui' && config.comfyMode !== 'simple'
        ? usable().find(item => item.id === config.defaultWorkflow)
        : null
      const guidanceBackend = promptBackendContext(config, guidanceWorkflow)
      const guidance = getPromptGuidance(config, guidanceBackend)
      const system = buildPlannerSystem({
        rules: plannerContext.staticRules, dynamicRules: plannerContext.dynamicRules,
        roster, rosterIndex: plannerContext.rosterIndex, count: want,
        extra: [config.plannerExtra, guidance].filter(Boolean).join('\n\n'),
        smartSelection: smart, characterUpdates, force: Boolean(force || manual),
      })
      const contextBoundary = system.indexOf('\n\n<本轮上下文>\n')
      lastPlannerContext = {
        ...plannerContext.diagnostics, at: Date.now(), turn: Number(turn) || null,
        messageId: String(messageId ?? ''), backend: config.imageBackend,
        staticChars: contextBoundary < 0 ? system.length : contextBoundary,
        dynamicChars: contextBoundary < 0 ? 0 : system.length - contextBoundary,
        bodyChars: body.length,
      }
      const traceId = imageGeneration ? diag.begin({ kind: 'planMessage', messageId: String(messageId ?? ''), turn: Number(turn) || null, textVersion: String(textVersion ?? ''), manual: Boolean(manual), force: Boolean(force), smart, characterUpdates: Boolean(characterUpdates), reusePlan: Boolean(reusePlan) }) : null
      let traceImageIndex = 0
      if (traceId) {
        const T = diag.text
        diag.record(traceId, 'planner-input', { body: T(body), card: card?.name ?? null, historySnapshotTurn: historySnapshot?.turn ?? null, config: { promptMode: config.promptMode, traitMode: config.traitMode, negativeMode: config.negativeMode, injectWeight: config.injectWeight, weightMode: config.weightMode, imageBackend: config.imageBackend, comfyMode: config.comfyMode, defaultWorkflow: config.defaultWorkflow, imageSize: config.imageSize, sizes: config.sizes, activePromptPreset: config.activePromptPreset, artistPosition: config.artistPosition } })
        diag.record(traceId, 'planner-context', { diagnostics: plannerContext.diagnostics, scopedCharacterIds: scoped.characters.map(c => String(c.id ?? '')), roster: T(roster), rosterIndex: T(plannerContext.rosterIndex) })
        diag.record(traceId, 'planner-request', { layer: 'llm.stream arguments (not provider HTTP body)', provider, model, reasoningEffort: plannerEffort ?? null, temperature: Number(config.plannerTemperature) || 1, maxTokens: 12000, system: T(system), user: T(body) })
      }

      const task = beginTask('规划', imageGeneration ? '正文配图 · 最多 ' + want + ' 张' : '角色视觉历史更新')
      const abort = () => task.controller.abort(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const started = Date.now()
      logger.info?.('dsh-tavern-image: 开始规划（' + provider + '/' + model + (config.plannerProvider ? '，插件指定' : '，跟随 Tavern 后台模型') + '，固定上下文 ' + lastPlannerContext.staticChars + ' 字，动态上下文 ' + lastPlannerContext.dynamicChars + ' 字）')
      const plans = []
      const manualBatch = manual ? randomUUID() : ''
      const seen = new Set()
      const seenPrompts = new Set()
      let submitChain = Promise.resolve()
      let submitError = null
      let streamed = ''
      let streamDecision = ''
      let decisionFrozen = false
      let streamConflict = null
      let submissionStopped = false
      let historyWarning = ''
      let storyApplied = !characterUpdates
      const applyStoryBlock = source => {
        const parsedStory = parsePlannerDecision(source)
        if (!parsedStory.characterUpdatesPresent) return false
        storyApplied = true
        if (!parsedStory.characterUpdatesValid) {
          historyWarning = '角色更新 JSON 无法解析；本轮沿用之前的外貌快照'
          visualSnapshot = { ...visualSnapshot, warning: historyWarning }
        } else {
          try {
            const merged = mergeCharacterUpdates(visualSnapshot, scoped, parsedStory.characterUpdates, { turn, textVersion, at: Date.now() })
            visualSnapshot = boundCharacterSnapshot({ ...merged.snapshot, gameId: String(sessionId ?? ''), turn: Number(turn) || 0, textVersion: String(textVersion ?? '') })
          } catch (error) {
            historyWarning = String(error?.message ?? error)
            visualSnapshot = { ...visualSnapshot, warning: historyWarning }
            try { visualSnapshot = boundCharacterSnapshot({ ...visualSnapshot, gameId: String(sessionId ?? ''), turn: Number(turn) || 0, textVersion: String(textVersion ?? '') }) } catch {}
          }
          const updated = applyCharacterSnapshot(definitions, visualSnapshot)
          scoped.characters = updated.characters.filter(character => usableOnCard(character, card))
        }
        return true
      }
      const streamImagesReadyForHistory = () => {
        if (!characterUpdates) return parseImagePlan(streamed)
        const historyEnd = streamed.toLowerCase().indexOf('</character_updates>')
        if (historyEnd < 0) return []
        return [...streamed.matchAll(/<image\b[^>]*>[\s\S]*?<\/image>/gi)]
          .filter(match => match.index > historyEnd)
          .flatMap(match => parseImagePlan(match[0]))
      }
      // 只提交已经闭合的 <image> 块；提交仍排队，ComfyUI 保持自己的 GPU 执行队列。
      // 第一张可以在模型继续规划后续画面时开画，无需等整份规划结束。
      const submitImages = images => {
        for (const image of images) {
          if (!imageGeneration || submissionStopped) continue
          if (smart && (streamDecision !== 'draw' || !decisionFrozen || streamConflict)) continue
          if (!image.mount || !body.includes(image.mount) || !String(image.prompts ?? '').trim()) continue
          const identity = JSON.stringify([image.mount, image.prompts])
          const promptIdentity = String(image.prompts).replace(/\s+/g, ' ').trim().toLowerCase()
          if (seen.has(identity) || seenPrompts.has(promptIdentity) || seen.size >= want) continue
          seen.add(identity)
          seenPrompts.add(promptIdentity)
          submitChain = submitChain.then(async () => {
            task.controller.signal.throwIfAborted()
            if (submissionStopped || !imageGeneration || (smart && (!decisionFrozen || streamDecision !== 'draw' || streamConflict))) return
            const key = ('plan|' + (manualBatch ? 'manual:' + manualBatch + '|' : '') + (messageId ?? '') + '|' + image.mount + '|' + image.prompts).slice(0, 3800)
            const imageIndex = ++traceImageIndex
            const macros = traceId ? [] : null
            const expanded = expandRosterCalls(image.prompts, scoped, config.traitMode, { style: rosterStyle(config, plannerWorkflow), onMacro: macros ? entry => macros.push(entry) : null })
            const normalizedTag = normalizePrompts(expanded, scoped, { backend: config.imageBackend, style: rosterStyle(config, plannerWorkflow) })
            if (traceId) {
              const T = diag.text
              diag.record(traceId, 'image-adopted', { mount: T(image.mount), size: image.size ?? null, prompts: T(image.prompts), adoptedAtStreamChars: streamed.length }, { imageIndex })
              diag.record(traceId, 'macro-expansion', { macros: macros.map(m => ({ ...m, origins: (m.origins ?? []).map(o => ({ ...o, text: T(o.text) })) })), expanded: T(expanded), normalized: T(normalizedTag) }, { imageIndex })
            }
            const job = await startJob({
              tag: normalizedTag,
              rawTag: image.prompts, size: image.size, key, sessionId, turn, textVersion, characterSnapshot: visualSnapshot,
            }, { label: 'agent 规划', diagTrace: traceId ? { traceId, imageIndex } : null })
            if (traceId) diag.record(traceId, 'image-job', { jobId: job.id, status: job.status }, { imageIndex })
            // startJob 返回的是 publicJob，size 已经是 "896x1152" 这样的文字。
            const item = { ...image, jobId: job.id, status: job.status, sizeText: sizeLabel(job.size) }
            plans.push(item)
            onPlan?.(item)
            task.controller.signal.throwIfAborted()
          }).catch(error => { submitError ||= error })
        }
      }
      let result = { text: '', usage: null, failure: null }
      let failure = null
      try {
        const cached = reusePlan && !smart && !characterUpdates && messageId ? plansByMessage.get(String(messageId)) : null
        if (cached?.plans?.length && !cached.error) {
          submitImages(cached.plans)
        } else result = await runPlanner(deps.llm, {
          provider,
          model,
          reasoningEffort: plannerEffort,
          system,
          text: body,
          temperature: Number(config.plannerTemperature) || 1,
          signal: task.controller.signal,
          onDelta: delta => {
            streamed += delta
            if (characterUpdates && !storyApplied && /<\/character_updates>/i.test(streamed)) applyStoryBlock(streamed)
            if (smart) {
              const starts = [...streamed.matchAll(/<decision\b/gi)]
              const decisions = [...streamed.matchAll(/<decision\b[^>]*>([\s\S]*?)<\/decision>/gi)]
              const reasonStarts = [...streamed.matchAll(/<reason\b/gi)]
              const reasons = [...streamed.matchAll(/<reason\b[^>]*>[\s\S]*?<\/reason>/gi)]
              const updateStarts = [...streamed.matchAll(/<character_updates\b/gi)]
              const updates = [...streamed.matchAll(/<character_updates\b[^>]*>[\s\S]*?<\/character_updates>/gi)]
              const current = parsePlannerDecision(streamed)
              if (starts.length > 1 || reasonStarts.length > 1 || updateStarts.length > 1) {
                streamConflict ||= new Error('智能配图出现重复或矛盾的决定；已停止后续提交')
                submissionStopped = true
              }
              const firstImage = /<image\b/i.exec(streamed)
              const choiceIndex = decisions[0]?.index ?? -1
              const choiceEnd = decisions[0] ? decisions[0].index + decisions[0][0].length : -1
              const reasonIndex = reasons[0]?.index ?? -1
              const reasonEnd = reasons[0] ? reasons[0].index + reasons[0][0].length : -1
              const updateEnd = updates[0] ? updates[0].index + updates[0][0].length : -1
              if (!decisionFrozen && !streamConflict && decisions.length === 1 && reasons.length === 1 && current.decision && current.reason
                && (!characterUpdates || (updates.length === 1 && storyApplied && updateEnd <= choiceIndex))
                && choiceEnd <= reasonIndex
                && (!firstImage || reasonEnd <= firstImage.index)) {
                decisionFrozen = true
                streamDecision = current.decision
              }
              if (decisionFrozen && !streamConflict && streamDecision === 'draw') submitImages(streamImagesReadyForHistory())
            } else if ((!characterUpdates || storyApplied)) submitImages(parseImagePlan(streamed))
          },
        })
      } catch (error) {
        failure = error
        submissionStopped = true
      }
      const plannerOutput = result.text || streamed
      if (traceId) diag.record(traceId, 'planner-response', { raw: diag.text(plannerOutput), streamedChars: streamed.length, resultTextChars: String(result.text ?? '').length, usage: result.usage ?? null, failure: result.failure ?? null, error: failure ? String(failure?.message ?? failure) : null, complete: !failure && !result.failure })
      const parsed = parsePlannerDecision(plannerOutput)
      if (characterUpdates && !storyApplied) {
        if (parsed.characterUpdatesPresent) applyStoryBlock(result.text || streamed)
        else {
          storyApplied = true
          historyWarning = '规划结果缺少角色更新块；本轮沿用之前的外貌快照'
          visualSnapshot = { ...visualSnapshot, warning: historyWarning }
        }
      }
      let skipped = false
      if (smart && !['draw', 'skip'].includes(parsed.decision)) failure ||= new Error('规划结果缺少明确的 draw/skip 决定')
      const plannedImages = parseImagePlan(plannerOutput)
      if (smart) {
        const output = String(plannerOutput ?? '')
        const decisions = [...output.matchAll(/<decision\b[^>]*>[\s\S]*?<\/decision>/gi)]
        const reasons = [...output.matchAll(/<reason\b[^>]*>[\s\S]*?<\/reason>/gi)]
        const updates = [...output.matchAll(/<character_updates\b[^>]*>[\s\S]*?<\/character_updates>/gi)]
        const imageStarts = [...output.matchAll(/<image\b/gi)]
        const imageBlocks = [...output.matchAll(/<image\b[^>]*>[\s\S]*?<\/image>/gi)]
        const decisionEnd = decisions[0] ? decisions[0].index + decisions[0][0].length : -1
        const reasonEnd = reasons[0] ? reasons[0].index + reasons[0][0].length : -1
        if (decisions.length !== 1 || reasons.length !== 1 || (characterUpdates && updates.length !== 1)
          || decisions[0]?.index >= reasons[0]?.index
          || (characterUpdates && updates[0]?.index + updates[0]?.[0].length > decisions[0]?.index)
          || (imageStarts.length !== imageBlocks.length)
          || imageStarts.some(match => match.index < reasonEnd)) {
          failure ||= new Error('智能配图输出标签顺序或完整性无效；没有提交违反协议的新图片')
          submissionStopped = true
        }
      }
      if (smart && !parsed.reason) failure ||= new Error('智能配图决定必须说明原因')
      if (smart && parsed.decision === 'skip' && plannedImages.length) failure ||= new Error('skip 决定与 image 块冲突，未提交图片')
      if (smart && parsed.decision === 'draw' && !plannedImages.length) failure ||= new Error('选择配图后没有返回可用的 <image> 块')
      if (smart) {
        failure ||= streamConflict
        if (failure || result.failure) submissionStopped = true
        if (!decisionFrozen && !failure && !result.failure && parsed.decision && parsed.reason && (!characterUpdates || storyApplied)) {
          decisionFrozen = true
          streamDecision = parsed.decision
        }
        if (parsed.decision === 'skip' && !failure && !result.failure && !plannedImages.length) skipped = true
        if (parsed.decision === 'draw' && decisionFrozen && !streamConflict) submitImages(plannedImages)
      } else if (imageGeneration) submitImages(plannedImages)
      await submitChain
      signal?.removeEventListener('abort', abort)
      failure ||= submitError || (result.failure ? new Error(result.failure) : null)
      if (task.controller.signal.aborted) {
        const error = task.controller.signal.reason || new Error('规划被取消')
        finishTask(task, error)
        throw error
      }
      if (imageGeneration && !skipped && !plans.length) failure ||= new Error('模型没有返回可用的 <image> 块')
      if (smart && parsed.decision === 'draw' && !plans.length) failure ||= new Error('选择配图后没有返回可用的 <image> 块')
      finishTask(task, failure)
      if (traceId) diag.record(traceId, 'planner-finished', { plans: plans.map(p => ({ jobId: p.jobId, status: p.status })), skipped, error: failure ? String(failure?.message ?? failure) : null })
      logger.info?.('dsh-tavern-image: 规划用了 ' + ((Date.now() - started) / 1000).toFixed(1) + 's，已提交 ' + plans.length + ' 张'
        + (result.usage ? '（token ' + result.usage.inputTokens + '+' + result.usage.outputTokens + '）' : ''))

      const characterSnapshot = characterUpdates ? visualSnapshot : null
      const plan = { messageId: String(messageId ?? ''), turn, at: Date.now(), plans, skipped, reason: parsed.reason, characterSnapshot, historyWarning, raw: plans.length ? '' : String(result.text || streamed).slice(0, 4000), card: card?.name ?? null }
      if (failure) plan.error = String(failure?.message ?? failure)
      if (messageId) plansByMessage.set(String(messageId), plan)
        persistPlans()
      try { addClientReport({ at: Date.now(), stage: 'host-plans-store', data: { id: String(messageId).slice(0, 14), plans: plan.plans ? plan.plans.length : 0, mapSize: plansByMessage.size } }) } catch {}
      return plan
    }

    // 这里以前有个 ensureInlineRegex()：每次规划都往「用户正在玩的那张卡」的
    // regex_scripts 里塞一条把 [[img:key]] 换成 <img> 的显示正则。
    //
    // 现在整块删掉了，原因有两个：
    //   1. 图由 Tavern 官方的 tavern.attach 渲染（宿主侧按 anchor 挂、跟正文版本绑定），
    //      插件这边不再需要任何显示正则；
    //   2. 直接改用户的卡文件会绕过 Tavern 的卡片管理与备份 —— 那是别人的数据，
    //      插件没有理由去写它。

    /** 从会话里读某条消息的正文（不传 messageId 就取最后一条助手消息）。 */
    function messageTextFrom(sessionId, messageId) {
      try {
        const session = deps.sessions?.get?.(sessionId)
        if (!session || typeof session.deriveMessages !== 'function') return ''
        const messages = session.deriveMessages() ?? []
        let target = null
        if (messageId) target = messages.find(item => String(item?.id) === String(messageId)) ?? null
        if (!target) {
          const assistants = messages.filter(item => item?.role === 'assistant')
          target = assistants[assistants.length - 1] ?? messages[messages.length - 1] ?? null
        }
        if (!target) return ''
        return (target.content ?? [])
          .filter(block => block && block.type === 'text')
          .map(block => String(block.text ?? ''))
          .join('')
      } catch (error) {
        logger.warn?.('dsh-tavern-image: 读消息正文失败 ' + (error?.message ?? error))
        return ''
      }
    }

    /** 用「角色与服装设计规范」让 agent 产出 <人物> / <服装>。 */
    async function designCharacters({ brief, sessionId, useCard, photo, current }) {
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务')
      const rules = await readFile(join(ROOT, 'design-rules.md'), 'utf8').catch(() => '')
      if (!rules) throw new Error('读不到 design-rules.md')
      const fallback = await backgroundModel(sessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      const plannerEffort = plannerEffortFor(fallback)
      if (!provider || !model) throw new Error('没定用哪个模型（Tavern 后台模型是空的，就来本插件设置里指定一个）')

      let context = ''
      if (useCard !== false) {
        const card = await currentCard(sessionId)
        // 卡设定走官方接口（已做宏投影），不再自己读卡文件
        const data = await cardContextRaw(sessionId)
        if (data) {
          context = [
            '【当前卡】' + (card?.name ?? ''),
            String(data.description ?? '').slice(0, 4000),
            String(data.personality ?? '').slice(0, 1200),
            String(data.scenario ?? '').slice(0, 1500),
          ].filter(Boolean).join('\n')
        }
      }

      // 有参考图就先让视觉模型描述它，作为设计依据
      let photoNote = ''
      if (photo?.data) {
        try {
          const seen = await describePhoto({ data: photo.data, mediaType: photo.mediaType, name: photo.name, sessionId })
          // describePhoto 返回的是 { ok, raw, traits, size } —— traits 是分块的 tag，不是一整段文字。
          // 之前这里写成 seen.description / seen.text（不存在的字段），所以参考图描述永远是空的。
          const blocks = seen?.traits && typeof seen.traits === 'object' ? seen.traits : null
          const desc = blocks
            ? [
                blocks.face ? '正面：' + blocks.face : '',
                blocks.faceBack ? '背面：' + blocks.faceBack : '',
                blocks.bodySFW ? '上半身（穿衣）：' + blocks.bodySFW : '',
                blocks.fullSFW ? '全身（穿衣）：' + blocks.fullSFW : '',
                blocks.bodyNSFW ? '上半身（赤裸）：' + blocks.bodyNSFW : '',
                blocks.fullNSFW ? '全身（赤裸）：' + blocks.fullNSFW : '',
                blocks.negative ? '不应出现：' + blocks.negative : '',
              ].filter(Boolean).join('\n')
            : String(seen?.raw ?? '').slice(0, 2000)
          if (desc) {
            photoNote = [
              '【参考图（最高优先级）】',
              '用户上传了一张参考图，下面是这张图的实际内容（由视觉模型读出来的）：',
              desc.slice(0, 2500),
              '硬性要求：角色的外貌、发型、瞳色、体型、服装样式必须以上面这份描述为准。',
              '卡片设定只用来补年代背景和世界观，绝不能覆盖参考图里的外貌特征。',
            ].join('\n')
          }
          logger.info?.('dsh-tavern-image: 参考图描述 ' + desc.length + ' 字')
        } catch (error) {
          logger.warn?.('dsh-tavern-image: 参考图描述失败 ' + (error?.message ?? error))
          photoNote = '（参考图读取失败，请检查设置页的看图模型：' + String(error?.message ?? error).slice(0, 80) + '）'
        }
      }

      // 改进模式：带上现有角色，要求保持中英文名不变、只改要改的部分
      let improveNote = ''
      if (current && typeof current === 'object' && current.name) {
        const slim = {
          name: current.name,
          match: current.match ?? '',
          note: current.note ?? '',
          traits: current.traits ?? {},
          outfits: (current.outfits ?? []).map(o => ({
            name: o.name ?? '', upper: o.upper ?? '', lower: o.lower ?? '', shoes: o.shoes ?? '',
            accessory: o.accessory ?? '', full: o.full ?? '', back: o.back ?? '', negative: o.negative ?? '',
          })),
        }
        improveNote = [
          '【这是改进任务，不是新建】',
          '下面是已有的角色设定，请在它基础上按用户要求修改：',
          JSON.stringify(slim, null, 1),
          '硬性要求：',
          '1. 中文名称与英文名称必须和上面完全一致，一个字都不能改；',
          '2. 只输出这一个人物（以及他的全部服装），不要输出别的角色；',
          '3. 用户没提到要改的字段，原样保留原值，不要自行"优化"；',
          '4. 负面字段依然绝对不能出现年龄、体型、身高类词。',
        ].join('\n')
      }

      const ask = [
        // 有参考图时它排第一：模型对靠前的内容权重更高
        photoNote,
        improveNote,
        brief ? '用户的要求：' + brief : '',
        photoNote
          ? '（上面的参考图描述是外貌与服装的唯一依据；下面这段卡片设定只用来看年代背景和世界观）'
          : '',
        context ? (photoNote ? '以下是背景资料（当前卡片的设定）：\n' + context : '以下是参考资料（当前卡片的设定，请从这里提取角色外貌与年代背景）：\n' + context) : '',
        !brief && !photoNote ? '用户没有额外要求，请按参考资料的设定设计主要角色（2-3 位）以及每人 2-3 套服装。' : '',
        '严格按规范输出 <人物> 块，每个 <人物> 里可以嵌若干 <服装>。只输出这些块。',
      ].filter(Boolean).join('\n\n')

      const task = beginTask('设计', '角色与服装设计')
      logger.info?.('dsh-tavern-image: 开始设计角色（' + provider + '/' + model + '，规范 ' + rules.length + ' 字）')
      let result
      try {
        result = await runPlanner(deps.llm, { provider, model, reasoningEffort: plannerEffort, system: rules, text: ask, temperature: 0.85, maxTokens: 12000, signal: task.controller.signal })
        finishTask(task)
      } catch (error) {
        finishTask(task, error)
        throw error
      }
      const people = parseDesign(result.text)
      logger.info?.('dsh-tavern-image: 设计完成，解析出 ' + people.length + ' 个人物')
      return { people, raw: people.length ? '' : String(result.text ?? '').slice(0, 4000) }
    }

    /** 上传的照片 → 按可见块拆好的 tag。 */
    async function describePhoto({ data, mediaType, name, sessionId }) {
      if (!deps.attachments?.saveImage) throw new Error('当前 DSH 没有 attachments 服务，收不了图片')
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务')
      const bytes = Buffer.from(String(data ?? '').replace(/^data:[^,]+,/, ''), 'base64')
      if (!bytes.byteLength) throw new Error('图片是空的')
      const kind = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(mediaType)) ? String(mediaType) : 'image/png'
      const ref = await deps.attachments.saveImage({ data: new Uint8Array(bytes), mediaType: kind, name: String(name || 'photo') })

      const fallback = await backgroundModel(sessionId)
      const provider = config.visionProvider || config.plannerProvider || fallback?.provider || ''
      const model = config.visionModel || config.plannerModel || fallback?.model || ''
      if (!provider || !model) throw new Error('没定看图用哪个模型（Tavern 后台模型是空的，就来本插件设置里指定一个）')


      const task = beginTask('看图', '照片 → tag')
      logger.info?.('dsh-tavern-image: 看图写 tag（看图模型=' + provider + '/' + model + '，附件 ' + ref.width + 'x' + ref.height + '，attachmentId=' + String(ref.attachmentId ?? ref.id ?? '无').slice(0, 12) + '）')
      let result
      try {
        result = await runPlanner(deps.llm, {
        signal: task.controller.signal,
        provider, model, system: VISION_SYSTEM,
        reasoningEffort: config.visionEffort,
        text: '把这张图里的人物写成 tag，按约定返回 JSON。',
        images: [ref],
        temperature: 0.4,
        maxTokens: 2000,
        })
        finishTask(task)
      } catch (error) {
        finishTask(task, error)
        throw error
      }
      try {
        globalThis.__rphubLastVision = {
          at: Date.now(),
          provider, model,
          imageCount: 1,
          raw: String(result.text ?? '').slice(0, 1500),
        }
      } catch {}
      const raw = String(result.text ?? '').trim()
      const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
      let parsed = null
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { parsed = null }
      }
      if (!parsed) return { ok: true, raw, traits: null }
      const traits = {}
      for (const key of ['face', 'faceBack', 'bodySFW', 'fullSFW', 'bodyNSFW', 'fullNSFW', 'negative']) {
        traits[key] = typeof parsed[key] === 'string' ? parsed[key].trim() : ''
      }
      return { ok: true, raw, traits, size: ref.width + 'x' + ref.height }
    }

    let lastPlan = null
    /** 正文指纹：工具那条路没有消息 id，用它跟正文对上。 */
    function hashText(value) {
      let a = 2166136261
      const source = String(value ?? '')
      for (let i = 0; i < source.length; i++) a = Math.imul(a ^ source.charCodeAt(i), 16777619)
      return (a >>> 0).toString(36)
    }

    function plansFor(messageId) {
      return messageId ? plansByMessage.get(String(messageId)) ?? null : null
    }

    /**
     * 前台模型调用工具时走这条路：它在 agent 链里，能拿到发起者身份，
     * 所以这里的规划是"带着卡片上下文"跑的，和后台自动规划共用同一套规划逻辑。
     */
    async function planFromTool({ text, count, sessionId }) {
      try {
        const plan = await planMessage({
          text,
          messageId: 'tool-' + Date.now(),
          turn: 0,
          count,
          sessionId,
          manual: true,
        })
        if (!plan || !plan.plans || !plan.plans.length) {
          return { ok: false, generated: 0, note: '配图没产出：' + (plan?.error || '模型没有返回可用的 <image> 块') }
        }
        lastPlan = plan
        lastPlan.textHash = hashText(text)
        const marks = plan.plans.map(item => {
          const key = String(item.jobId ?? '').slice(0, 8)
          const where = String(item.mount ?? '').replace(/\s+/g, ' ').slice(0, 42)
          const what = String(item.title ?? '').slice(0, 20)
          return '- 在「' + where + '」这一句之后插入 [[img:' + key + ']]' + (what ? '（' + what + '）' : '')
        }).join('\n')
        return {
          ok: true,
          generated: plan.plans.length,
          note: '已提交 ' + plan.plans.length + ' 张插图，正在后台绘制。\n'
            + '现在请输出这一轮的正文，并在下面这些位置原样插入标记（标记不要改动、不要解释）：\n' + marks,
        }
      } catch (error) {
        return { ok: false, generated: 0, note: '配图失败：' + (error?.message ?? String(error)) }
      }
    }

    function sweep() {
      if (jobs.size <= 200) return
      const ordered = [...jobs.values()].filter(job => !['pending', 'running'].includes(job.state)).sort((a, b) => a.createdAt - b.createdAt)
      for (const job of ordered.slice(0, jobs.size - 200)) {
        jobs.delete(job.id)
        if (job.key) byKey.delete(job.key)
      }
    }

    function publicJob(job) {
      return {
        id: job.id, status: job.state, state: job.state, percent: job.percent ?? 0,
        comfyId: job.comfyId || '',
        queuePosition: job.queuePosition ?? 0, queuedCount: job.queuedCount ?? 0,
        seed: job.seed, workflow: job.workflowId, error: job.error ?? undefined, createdAt: job.createdAt,
        backend: job.backend ?? 'comfyui', channelName: job.channelName ?? '',
        mediaType: job.mediaType ?? '', imageOutputWarning: job.imageOutputWarning ?? '',
        requestStarted: job.requestStarted === true,
        requestMayHaveSucceeded: job.requestMayHaveSucceeded === true,
        providerTaskId: job.providerTaskId || undefined,
        cancelMayHaveContinued: job.cancelMayHaveContinued === true,
        size: job.size ? job.size.width + 'x' + job.size.height : '',
      }
    }

    function consoleJob(job) {
      return {
      workflowId: job.workflowId ?? '', workflowLabel: job.workflowLabel ?? '', loras: Array.isArray(job.loras) ? job.loras : [],
        ...publicJob(job),
        prompt: job.positive ?? '', negative: job.negative ?? '', tag: job.params?.tag ?? '',
        rawPrompt: job.params?.rawTag || job.params?.tag || job.positive || '',
        artist: job.params?.artist ?? '', size: job.size ? `${job.size.width}x${job.size.height}` : '',
        hits: job.hits ?? [], hasImage: job.state === 'done' && Boolean(job.byteLength), label: job.label ?? '',
        byteLength: job.byteLength ?? 0, mediaType: job.mediaType ?? '', completedAt: job.completedAt ?? null,
        imageOutputWarning: job.imageOutputWarning ?? '',
      }
    }

    function sendImage(response, job, rangeHeader) {
      const total = job.byteLength
      if (!job.file || !total) { sendJson(response, 404, { ok: false, error: '图片还没生成好' }); return }
      const type = job.mediaType || 'image/png'
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? '').trim())
      if (match) {
        let start = match[1] === '' ? null : Number(match[1])
        let end = match[2] === '' ? null : Number(match[2])
        if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1 }
        else { start = start ?? 0; end = end === null ? total - 1 : Math.min(end, total - 1) }
        if (!Number.isFinite(start) || start > end || start >= total) {
          response.writeHead(416, { 'content-range': `bytes */${total}` })
          response.end()
          return
        }
        response.writeHead(206, {
          'content-type': type, 'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=1800',
        })
        createReadStream(job.file, { start, end }).pipe(response)
        return
      }
      response.writeHead(200, { 'content-type': type, 'content-length': total, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=1800' })
      createReadStream(job.file).pipe(response)
    }

    async function readBody(request, limit = 4 * 1024 * 1024) {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > limit) throw new Error('请求过大')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return {}
      if (String(request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text))
      try { return JSON.parse(text) } catch { throw new Error('请求体不是有效 JSON') }
    }

    let consoleCache = null
    async function consoleHtml() {
      const info = await stat(CONSOLE_PATH).catch(() => null)
      if (!info) return null
      if (!consoleCache || consoleCache.mtime !== info.mtimeMs) consoleCache = { mtime: info.mtimeMs, html: await readFile(CONSOLE_PATH, 'utf8') }
      return consoleCache.html
    }

    /** 诊断用：记录最近的模型调用，只留最近 60 条（不清理会一直涨）。 */
    function pushLlmDiag(entry) {
      try {
        const list = globalThis.__rphubLlmCalls ?? (globalThis.__rphubLlmCalls = [])
        list.push(entry)
        if (list.length > 60) list.splice(0, list.length - 60)
      } catch {}
    }

    /** 一次性诊断：DSH 到底认不认这个包、客户端模块表里有没有它。 */
    async function diagnose() {
      const out = { name: 'dsh-tavern-image' }
      try {
        const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
        if (loader && typeof loader.entries === 'function') {
          const names = []
          for (const entry of loader.entries()) names.push(String(entry?.options?.name ?? entry?.name ?? '?'))
          out.loaderCount = names.length
          out.loaderHit = names.filter(n => /rphub|wrongbook|tavern-plugin/i.test(n))
        } else {
          out.loaderError = '拿不到 loader'
        }
      } catch (error) { out.loaderError = String(error?.message ?? error) }
      try {
        const registry = typeof ctx.get === 'function' ? (ctx.get('clientModules') ?? ctx.get('client-module-registry')) : undefined
        if (registry && registry.table && typeof registry.table.keys === 'function') {
          out.clientTable = [...registry.table.keys()]
          // 已登记的 bundle URL 清单（含修订号）——这才是浏览器真正会去取的东西
          try {
            if (registry.responses && typeof registry.responses.keys === 'function') {
              out.responseCount = registry.responses.size
              const keys = [...registry.responses.keys()]
              out.responseKeys = keys.filter(u => /rphub|wrongbook|slots|tavern-plugin/i.test(u)).slice(0, 20)
              out.responseSample = keys.slice(0, 3)
              out.myBundle = keys.filter(u => /rphub/i.test(u))
            }
          } catch (error) { out.responseError = String(error?.message ?? error) }
          // 我自己的 entry 在表里长什么样
          try {
            const record = registry.table.get('dsh-tavern-image')
            if (record) {
              out.myRecord = {
                id: record.entry?.id,
                rev: record.entry?.rev ?? record.rev ?? null,
                url: record.entry?.url ?? null,
                clientPath: record.meta?.clientPath ?? null,
                hasBundle: Boolean(record.bundle),
                inject: record.meta?.inject ?? null,
                baseline: record.baseline ? 'yes' : 'no',
              }
            } else out.myRecord = 'not-in-table'
          } catch (error) { out.myRecordError = String(error?.message ?? error) }
          const mine = out.clientTable.filter(n => /rphub/i.test(String(n)))
          out.clientHasMine = mine
          out.clientError = registry.sources ? null : null
          try {
            registry.resolveMeta && (out.meta = null)
          } catch {}
        } else {
          out.clientTable = 'no-registry'
        }
      } catch (error) { out.clientError = String(error?.message ?? error) }

      // 顺手复刻一次扫描判定
      try {
        const { createRequire } = await import('node:module')
        const require2 = createRequire(TAVERN_SETTINGS)
        let pkgPath
        try { pkgPath = require2.resolve('dsh-tavern-image/package.json') }
        catch { pkgPath = require2.resolve('dsh-tavern-comfy/package.json') }
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        out.scan = {
          resolved: pkgPath.replace(/\\/g, '/'),
          platform: pkg.dsh?.client?.platform ?? null,
          clientExport: pkg.exports?.['./client'] ?? null,
          inject: pkg.dsh?.client?.inject ?? null,
        }
      } catch (error) { out.scanError = String(error?.message ?? error) }
      return out
    }

    async function comfyHealth() {
      try {
        const response = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(4000), headers: Object.assign({}, comfyHeaders(config)) })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const data = await response.json().catch(() => ({}))
        return { ok: true, version: data?.system?.comfyui_version ?? '' }
      } catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    }

    async function consoleState() {
    const worldbookList = await worldbook().catch(() => [])
      return {
        ok: true,
        base: BASE,
        imageProviders: IMAGE_PROVIDERS,
        // 条目要带 enabled 和 content —— 前台要靠它们显示开关与编辑框
        worldbook: worldbookList.map(entry => ({
          index: entry.index,
          comment: entry.comment,
          length: entry.length,
          enabled: entry.enabled !== false,
          content: String(entry.content ?? ''),
          ...normalizeEntryActivation(entry),
        })),
        // 顺手把当前世界书的名字也带上
        worldbookName: String((await loadWorldbook().catch(() => ({ name: '' }))).name ?? ''),
        // 启用条数：生图规划 tab 用它显示"几条第几条在生效"
        worldbookEnabledCount: worldbookList.filter(e => e.enabled !== false && String(e.content ?? '').trim()).length,
      // 两本世界书各自的名字/条数/条目：前端用它的书选择器与折叠列表
      worldbookBooks: await worldbookBookIndex().catch(() => []),
        plannerContext: lastPlannerContext,
        pluginDownloads: { ...PLUGIN_DOWNLOADS, local: `${BASE}/plugin-download` },
        config: {
          imageBackend: config.imageBackend,
          activeImageChannel: config.activeImageChannel,
          imageChannels: publicChannels(config.imageChannels),
          imageConcurrency: config.imageConcurrency,
          comfyUrl: config.comfyUrl,
          comfyMode: config.comfyMode === 'simple' ? 'simple' : 'workflow',
          comfySimple: normalizeComfySimpleConfig(config.comfySimple),
          comfyAuthMode: String(config.comfyAuthMode ?? 'none'),
          comfyHasAuthToken: Boolean(config.comfyAuthToken),
          comfyAuthUser: String(config.comfyAuthUser ?? ''),
          comfyHasAuthPass: Boolean(config.comfyAuthPass),
          defaultWorkflow: config.defaultWorkflow, lockWorkflow: config.lockWorkflow,
          autoImageGen: config.autoImageGen, imageGenCount: config.imageGenCount,
          smartImageSelection: config.smartImageSelection !== false,
          characterAutoUpdate: config.characterAutoUpdate !== false,
          styleArtists: config.styleArtists ?? '', imageSize: config.imageSize ?? '竖图',
          // 正文插图统一显示宽度（0 = 默认）：前端启动时读一次，之后每张图都不再问服务端。
          imageDisplayWidth: normalizeImageDisplayWidth(config.imageDisplayWidth),
          stylePresets: Array.isArray(config.stylePresets) ? config.stylePresets : [],
          activePreset: String(config.activePreset ?? ''),
          styleNegative: String(config.styleNegative ?? ''),
          promptPresets: normalizePromptPresets(config.promptPresets),
          promptPresetLibrary: BUILTIN_PROMPT_PRESETS,
          activePromptPreset: String(config.activePromptPreset ?? ''),
          promptMode: ['auto', 'tags', 'natural', 'mixed'].includes(config.promptMode) ? config.promptMode : 'auto',
          promptEffectiveFormat: resolvePromptMode(config, config.imageBackend),
          promptEffectiveName: effectivePromptPreset(config)?.name ?? '',
          promptPreviewPositive: composePresetText(String(config.promptManualPositive ?? ''), config, config.imageBackend),
          promptPreviewNegative: [activeArtistText(config).negative, promptPresetNegative(config), String(config.promptManualNegative ?? '')].filter(Boolean).join(', '),
          promptManualPositive: String(config.promptManualPositive ?? ''),
          promptManualNegative: String(config.promptManualNegative ?? ''),
          jpegOutput: config.jpegOutput === true,
          jpegQuality: Math.max(50, Math.min(100, Number(config.jpegQuality) || 88)),
          jpegBackground: String(config.jpegBackground ?? '#ffffff'),
          artistSets: Array.isArray(config.artistSets) ? config.artistSets : [],
          activeArtistSet: String(config.activeArtistSet ?? ''),
          artistPosition: config.artistPosition, weightMode: config.weightMode, negativeMode: config.negativeMode,
          overrideSteps: config.overrideSteps, injectWeight: config.injectWeight, cacheDir: config.cacheDir,
          traitMode: config.traitMode ?? 'auto',
          diag: await diagnose().catch(error => ({ error: String(error?.message ?? error) })),
          indexTap: deps.indexTap ?? null,
          // Tavern 官方接口桥的自检：装了没、Tavern 给了哪些能力
          tavernBridge: deps.bridge ? { installed: true, exports: Object.keys(deps.bridge) } : { installed: false },
          tavernApi: deps.tavern ? { apiVersion: deps.tavern.apiVersion, hasAttach: typeof deps.tavern.attach === 'function', hasPromptSection: typeof deps.tavern.promptSection === 'function', hasGetTurn: typeof deps.tavern.getTurn === 'function', hasOnTurnSettled: typeof deps.tavern.onTurnSettled === 'function', hasTurnData: typeof deps.tavern.readTurnData === 'function' } : null,
          toolName: TOOL_NAME,
          toolsDiag: (() => { try { return globalThis.__rphubToolsDiag ?? null } catch { return null } })(),
          plannerEnabled: config.plannerEnabled !== false, plannerProvider: config.plannerProvider ?? '',
          visionProvider: config.visionProvider ?? '',
          plannerEffort: String(config.plannerEffort ?? ''),
          visionEffort: String(config.visionEffort ?? ''), visionModel: config.visionModel ?? '',
          llmDiag: (() => { try { return globalThis.__rphubLastLlmCall ?? null } catch { return null } })(),
          llmDiagList: (() => { try { return (globalThis.__rphubLlmCalls ?? []).slice(-60) } catch { return [] } })(),
          visionDiag: (() => { try { return globalThis.__rphubLastVision ?? null } catch { return null } })(),
          plannerModel: config.plannerModel ?? '', plannerCount: config.plannerCount ?? 3,
          plannerTemperature: config.plannerTemperature ?? 1, plannerExtra: config.plannerExtra ?? '',
          plannerEntries: Array.isArray(config.plannerEntries) ? config.plannerEntries : [],
          plannerEffective: await backgroundModel(lastSessionId).then(fb => ({
            provider: config.plannerProvider || fb?.provider || '',
            model: config.plannerModel || fb?.model || '',
            fromTavern: !config.plannerProvider && Boolean(fb),
          })).catch(() => ({ provider: config.plannerProvider || '', model: config.plannerModel || '', fromTavern: false })),
        },
        sizes: config.sizes ?? {},
        workflows: workflows.map(wf => ({
          id: wf.id, label: wf.label, file: wf.file, match: wf.match, sizes: wf.sizes, enabled: wf.enabled,
          error: wf.error, digest: wf.digest ?? '', summary: wf.summary ?? null, current: wf.id === config.defaultWorkflow,
        })),
        definitions,
        outfits: definitions.outfits ?? [],
        kinds: DEFINITION_KINDS,
        jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map(consoleJob),
        tasks: publicTasks(),
        clientReports: clientReports.slice(-40),
      }
    }

    let graphWrite = Promise.resolve()
    async function handleConsole(action, request, response, _url) {
      if (action === 'character-history') {
        const tavern = deps.tavern
        const api2 = Number(tavern?.apiVersion) >= 2 && typeof tavern?.readTurnData === 'function'
        if (!api2) { sendJson(response, 200, { ok: true, available: false, reason: '当前 Tavern 插件接口为 v1，角色历史需要 v2' }); return }
        try {
          if (request.method === 'GET') {
            const gameId = String(_url?.searchParams?.get('gameId') ?? '')
            if (!gameId) throw new Error('需要当前 gameId')
            const requestedTurn = Number(_url?.searchParams?.get('turn'))
            const seenTurn = Number(lastTurn.get(gameId))
            const turn = Number.isSafeInteger(requestedTurn) && requestedTurn > 0
              ? requestedTurn
              : Number.isSafeInteger(seenTurn) && seenTurn > 0 ? seenTurn : Number.MAX_SAFE_INTEGER
            const saved = await tavern.readTurnData({ gameId, turn })
            sendJson(response, 200, { ok: true, available: true, turn: saved?.turn ?? null, currentTurn: lastTurn.get(gameId) ?? null, textVersion: saved?.textVersion ?? null, snapshot: saved?.data ?? emptyCharacterSnapshot() })
            return
          }
          if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
          const origin = request.headers.origin
          if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作角色历史。' }); return
          }
          const body = await readBody(request, 12 * 1024)
          const gameId = String(body?.gameId ?? '')
          const changeIndex = Number(body?.changeIndex)
          if (!gameId || !Number.isSafeInteger(changeIndex) || changeIndex < 0) throw new Error('需要有效的 gameId 和历史记录编号')
          const currentTurn = Number(lastTurn.get(gameId))
          if (!Number.isSafeInteger(currentTurn) || currentTurn < 1) throw new Error('还没有获得当前轮次信息；请先等一轮结算或从消息下方打开生图按钮，再刷新角色历史')
          const assertCurrentTurn = () => {
            if (Number(lastTurn.get(gameId)) !== currentTurn) throw new Error('恢复期间当前轮次已变化，请刷新后重试')
          }
          const restore = async () => {
            // The request may have waited behind another same-game planner in the history lock.
            assertCurrentTurn()
            const latest = await tavern.readTurnData({ gameId, turn: currentTurn })
            assertCurrentTurn()
            const changes = Array.isArray(latest?.data?.changes) ? latest.data.changes : []
            const change = changes[changeIndex]
            if (!latest || !change) throw new Error('这条角色历史已不在当前剧情线上，请刷新后重试')
            const expected = body?.expectedChange
            const identityFields = ['id', 'field', 'turn', 'textVersion', 'at', 'before', 'after']
            if (!expected || typeof expected !== 'object' || identityFields.some(key =>
              !Object.prototype.hasOwnProperty.call(expected, key) || String(expected[key] ?? '') !== String(change[key] ?? '')
            )) throw new Error('角色历史记录已变化，请刷新后重试')
            const current = await tavern.getTurn?.({ gameId, turn: currentTurn })
            if (!current) throw new Error('当前轮次正文不可用，请等结算完成后重试')
            const character = definitions.characters.find(item => String(item?.id) === String(change.id))
            if (!character || !String(change.field ?? '')) throw new Error('角色已删除或历史字段无效')
            const snapshot = structuredClone(latest.data)
            snapshot.characters ||= {}
            const overlay = snapshot.characters[String(character.id)] ||= { traits: {} }
            overlay.traits ||= {}
            const before = String(overlay.traits[change.field] ?? character.traits?.[change.field] ?? '')
            const after = String(change.before ?? '')
            if (after) overlay.traits[change.field] = after
            else delete overlay.traits[change.field]
            snapshot.turn = currentTurn
            snapshot.textVersion = current.textVersion
            snapshot.changes.push({ id: String(character.id), name: String(character.name ?? ''), field: String(change.field), before, after, reason: '玩家从角色历史手动恢复', turn: currentTurn, textVersion: current.textVersion, at: Date.now() })
            snapshot.changes = snapshot.changes.slice(-120)
            const bounded = boundCharacterSnapshot(snapshot)
            const verify = await tavern.getTurn?.({ gameId, turn: currentTurn })
            assertCurrentTurn()
            if (!verify || verify.textVersion !== current.textVersion) throw new Error('恢复期间正文已变化，请刷新后重试')
            await tavern.saveTurnData({ gameId, turn: currentTurn, textVersion: current.textVersion, data: bounded })
          }
          if (typeof deps.bridge?.withHistoryLock === 'function') await deps.bridge.withHistoryLock(gameId, restore)
          else await restore()
          sendJson(response, 200, { ok: true, available: true, turn: currentTurn })
          return
        } catch (error) { sendJson(response, 400, { ok: false, error: String(error?.message ?? error) }); return }
      }
      if (['workflow-graph', 'image-channel-test'].includes(action)) {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
        const origin = request.headers.origin
        if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作' }); return
        }
        try {
          const body = await readBody(request)
          if (action === 'image-channel-test') {
            const channel = config.imageChannels.find(item => item.id === body?.id)
            if (!channel) throw new Error('请先保存渠道配置')
            const result = await testImageChannel(structuredClone(channel))
            sendJson(response, 200, result.ok ? result : { ...result, error: result.message || '渠道连接失败' })
          } else {
            const file = String(body?.file ?? '').replace(/^workflows[\\/]/, '')
            if (!file || /[\\/]/.test(file) || !/\.json$/i.test(file) || file.includes('..')) throw new Error('工作流文件名不正确')
            const operation = graphWrite.then(async () => {
              const path = join(WORKFLOW_DIR, file)
              let raw = await readJson(path, null)
              if (!raw?.prompt) throw new Error('找不到可编辑的 API 工作流')
              if (body.patch !== undefined) {
                raw = patchWorkflowGraph(raw, body.patch, body.revision)
                await writeJsonSafe(path, raw, join(ROOT, 'backups'))
                config.workflows = await scanWorkflows(config)
                await loadAllWorkflows()
              }
              return { ok: true, workflow: raw, revision: workflowRevision(raw) }
            })
            graphWrite = operation.catch(() => {})
            sendJson(response, 200, await operation)
          }
        } catch (error) { sendJson(response, 400, { ok: false, error: error.message }) }
        return
      }
      if (action.startsWith('plugin-update')) {
        const method = action === 'plugin-update' ? 'GET' : 'POST'
        if (request.method !== method) { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (method === 'POST') {
          const origin = request.headers.origin
          if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作更新。' }); return
          }
        }
        try {
          if (action === 'plugin-update') sendJson(response, 200, await updater.status())
          else if (action === 'plugin-update-check') { await readBody(request, 4096); sendJson(response, 200, await updater.check()) }
          else { const body = await readBody(request, 4096); sendJson(response, 200, await updater.apply(body?.target)) }
        } catch (error) { sendJson(response, 400, { ok: false, error: error.message }) }
        return
      }
      if (request.method === 'GET') {
        if (action === 'plugin-download') {
          try {
            const archive = await createDownloadPackage(ROOT)
            response.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition': 'attachment; filename="dsh-tavern-image-local.zip"',
              'Content-Length': archive.length,
              'Cache-Control': 'no-store',
            })
            response.end(archive)
          } catch (error) { sendJson(response, 400, { ok: false, error: String(error?.message ?? error) }) }
          return
        }
        if (action === 'worldbook-export') {
          try { sendJson(response, 200, { ok: true, worldbook: await loadWorldbook() }) }
          catch (error) { sendJson(response, 400, { ok: false, error: String(error?.message ?? error) }) }
          return
        }
        if (action === 'state') {
          const health = config.imageBackend === 'comfyui' ? await comfyHealth() : null
          sendJson(response, 200, { ...(await consoleState()), comfy: health })
          return
        }
        if (action === 'history') {
          sendJson(response, 200, { ok: true, jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map(consoleJob) })
          return
        }
        if (action === 'plans') {
          const messageId = String(_url?.searchParams?.get('messageId') ?? '')
          let plan = plansFor(messageId)
          try {
            addClientReport({
              at: Date.now(),
              stage: 'host-plans-query',
              data: { ask: messageId.slice(0, 14) || '(空)', hit: plan ? (plan.plans ? plan.plans.length : 0) : 0, mapSize: plansByMessage.size, keys: [...plansByMessage.keys()].map(k => String(k).slice(0, 10)).slice(0, 6), fallback: String(_url?.searchParams?.get('fallback') ?? '') },
            })
          } catch {}
          // 工具那条路是模型主动调的，对不上消息 id；正文里如果出现了那次的挂载句，就用最近一次
          if (!plan && lastPlan && _url?.searchParams?.get('fallback') === '1') {
            const wanted = String(_url?.searchParams?.get('hash') ?? '')
            if (wanted && lastPlan.textHash === wanted) plan = lastPlan
          }
          sendJson(response, 200, { ok: true, plan, plans: plan ? plan.plans : null })
          return
        }
        // GET 版：卡片列表（前端用 GET 取，避免 method 不匹配）
        if (action === 'cards') {
          try {
            const dir = join(TAVERN_DATA, 'resources', 'cards')
            const names = await readdir(dir).catch(() => [])
            const cards = []
            for (const name of names.filter(n => /\.json$/i.test(n))) {
              const payload = await readJson(join(dir, name), null).catch(() => null)
              const raw = payload?.raw ?? payload ?? null
              const title = String(raw?.name ?? '').trim()
              const count = Array.isArray(raw?.character_book?.entries) ? raw.character_book.entries.length : (Array.isArray(raw?.data?.character_book?.entries) ? raw.data.character_book.entries.length : 0)
              cards.push({ path: 'cards/' + name, name: name.replace(/\.json$/i, ''), title: title || name.replace(/\.json$/i, ''), entries: count })
            }
            cards.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
            sendJson(response, 200, { ok: true, cards })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }
        // GET 版：单张图的详情（提示词）
        if (action === 'job-detail') {
          const job = getJob(String(_url?.searchParams?.get('id') ?? ''))
          if (!job) { sendJson(response, 404, { ok: false, error: '没有这个作业' }); return }
          sendJson(response, 200, { ok: true, job: consoleJob(job) })
          return
        }
        // GET 版：卡片显示正则用的插图。
        // 浏览器 <img src> 只会发 GET，所以这条**必须**在 GET 分支里有（2026-10-07 修：
        // 之前只挂在 POST 分支下，导致卡里 [[img:xxx]] 渲染出来的图永远 405 取不到）。
        if (action === 'img') {
          try {
            const key = String(_url?.searchParams?.get('key') ?? '').toLowerCase()
            let hit = null
            for (const job of jobs.values()) {
              if (String(job.id).toLowerCase().startsWith(key) && key.length >= 6) { hit = job; break }
            }
            if (!hit) { sendJson(response, 404, { ok: false, error: '没有这个插图' }); return }
            if (hit.state !== 'done' || !hit.byteLength) { sendJson(response, 404, { ok: false, error: '这张还没画好' }); return }
            sendImage(response, hit, request.headers.range)
          } catch (error) {
            sendJson(response, 404, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (action === 'media-action') {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
        const origin = request.headers.origin
        if ((origin && origin !== _url?.origin) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作单图任务' }); return
        }
        try {
          const input = await readBody(request, 64 * 1024)
          if (!deps.mediaActions) throw new Error('Tavern 单图操作接口尚未就绪')
          sendJson(response, 200, await deps.mediaActions.handle(input))
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error), code: error?.code, submissionNotStarted: error?.submissionNotStarted === true })
        }
        return
      }
      const body = await readBody(request)

        // ---- 列出可用的 LLM provider / model（给设置页做下拉框，不用手打）----
        if (action === 'llm-models') {
          try {
            const llm = deps?.llm ?? deps?.ctx?.get?.('llm')
            if (!llm || typeof llm.listProviders !== 'function') {
              sendJson(response, 200, { ok: true, providers: [], models: [], error: '当前 DSH 没有可用的 llm 服务' })
              return
            }
            const providers = (llm.listProviders() ?? []).map(p => ({ id: String(p.id), name: String(p.name ?? p.id) }))
            const wantProvider = String(body?.provider ?? '')
            if (!wantProvider) {
              sendJson(response, 200, { ok: true, providers, models: [] })
              return
            }
            const models = []
            try {
              const list = await llm.listModels(wantProvider)
              for (const m of (list ?? [])) {
                const mods = Array.isArray(m.inputModalities) ? m.inputModalities.map(String) : []
                models.push({
                  id: String(m.id),
                  name: String(m.name ?? m.id),
                  description: String(m.description ?? ''),
                  // 能看图 = inputModalities 里有 image
                  vision: mods.includes('image'),
                })
              }
            } catch (error) {
              sendJson(response, 200, { ok: true, providers, models: [], error: '列模型失败：' + String(error?.message ?? error) })
              return
            }
            // 如果指定了具体模型，顺便把它的推理等级也带上
            let reasoning = null
            const wantModel = String(body?.model ?? '')
            if (wantModel) {
              try {
                const info = await llm.resolveModelInfo(wantProvider, wantModel)
                if (info?.reasoning?.efforts?.length) {
                  reasoning = {
                    efforts: info.reasoning.efforts.map(e => ({ id: String(e.id), name: String(e.name ?? e.id) })),
                    defaultEffort: info.reasoning.defaultEffort ? String(info.reasoning.defaultEffort) : '',
                  }
                }
              } catch { /* 拿不到就算了 */ }
            }
            sendJson(response, 200, { ok: true, providers, models, reasoning })
          } catch (error) {
            sendJson(response, 200, { ok: true, providers: [], models: [], error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 测 ComfyUI 连接（返回在线状态与版本）----
        if (action === 'comfy-test') {
          const base = String(body?.url || config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
          const started = Date.now()
          try {
            const headers = comfyHeaders({ comfyAuthMode: body?.authMode ?? config.comfyAuthMode, comfyAuthToken: body?.authToken ?? config.comfyAuthToken, comfyAuthUser: body?.authUser ?? config.comfyAuthUser, comfyAuthPass: body?.authPass ?? config.comfyAuthPass })
            let info = null
            let status = 0
            try {
              const res = await fetch(base + '/system_stats', { headers, signal: AbortSignal.timeout(8000) })
              status = res.status
              if (res.ok) info = await res.json()
            } catch (error) {
              sendJson(response, 200, { ok: false, url: base, ms: Date.now() - started, error: '连不上：' + String(error?.message ?? error).slice(0, 120) })
              return
            }
            const ok = Boolean(info)
            const version = String(info?.system?.comfyui_version ?? info?.system?.comfy_version ?? '')
            sendJson(response, 200, {
              ok, url: base, ms: Date.now() - started, version,
              device: String(info?.devices?.[0]?.name ?? ''),
              vram: info?.devices?.[0]?.vram_total ? Math.round(info.devices[0].vram_total / 1024 / 1024 / 1024) + 'GB' : '',
              status,
              error: ok ? '' : (status === 401 || status === 403 ? '鉴权失败（HTTP ' + status + '）—— 检查服务鉴权设置' : '连不上（ComfyUI 没开，或地址不对）HTTP ' + status),
            })
          } catch (error) {
            sendJson(response, 200, { ok: false, url: base, ms: Date.now() - started, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- Read-only model/node inventory for the built-in simple mode ----
        if (action === 'comfy-simple-info') {
          try {
            const objectInfo = await getSimpleObjectInfo(true)
            sendJson(response, 200, { ok: true, ...inspectComfySimple(objectInfo) })
          } catch (error) {
            sendJson(response, 200, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 简单编辑：直接读/写工作流里的参数值（正面/负面/宽高/步数/CFG/底模）----
        if (action === 'workflow-values') {
          try {
            const file = String(body?.file ?? '').replace(/^.*[\\\\/]/, '')
            if (!file) { sendJson(response, 400, { ok: false, error: '缺少文件名' }); return }
            const path = join(ROOT, 'workflows', file)
            const raw = await readJson(path, null)
            if (!raw) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            const prompt = raw.prompt ?? {}
            const b = raw.bindings ?? {}
            const nodeOf = (key) => { const it = (b[key] ?? [])[0]; return it ? prompt[it.node] : null }
            const inputOf = (key, fallback) => { const it = (b[key] ?? [])[0]; return it ? it.input : fallback }

            const readValue = (key, fallbackInput) => {
              const n = nodeOf(key)
              if (!n || !n.inputs) return undefined
              return n.inputs[inputOf(key, fallbackInput)]
            }
            // 尺寸：宽高分别取
            const sizeNode = nodeOf('size')
            const values = {
              positive: String(readValue('positive', 'text') ?? ''),
              negative: String(readValue('negative', 'text') ?? ''),
              width: sizeNode?.inputs?.width,
              height: sizeNode?.inputs?.height,
              steps: readValue('steps', 'steps'),
              cfg: readValue('cfg', 'cfg') ?? readValue('guidance', 'guidance'),
              model: String(readValue('model', 'ckpt_name') ?? ''),
            }

            if (body?.values && typeof body.values === 'object') {
              const v = body.values
              const setIn = (key, fallbackInput, value) => {
                const it = (b[key] ?? [])[0]
                if (!it) return false
                const n = prompt[it.node]
                if (!n || !n.inputs) return false
                const input = it.input || fallbackInput
                if (!Object.hasOwn(n.inputs, input)) return false
                n.inputs[input] = value
                return true
              }
              const done = []
              if (typeof v.positive === 'string') { setIn('positive', 'text', v.positive); done.push('正面') }
              if (typeof v.negative === 'string') { setIn('negative', 'text', v.negative); done.push('负面') }
              if (Number.isFinite(Number(v.width)) || Number.isFinite(Number(v.height))) {
                const n = nodeOf('size')
                if (n && n.inputs) {
                  if (Number.isFinite(Number(v.width))) n.inputs.width = Math.round(Number(v.width))
                  if (Number.isFinite(Number(v.height))) n.inputs.height = Math.round(Number(v.height))
                  done.push('尺寸')
                }
              }
              if (Number.isFinite(Number(v.steps))) { if (setIn('steps', 'steps', Math.round(Number(v.steps)))) done.push('步数') }
              if (Number.isFinite(Number(v.cfg))) {
                if (setIn('cfg', 'cfg', Number(v.cfg)) || setIn('guidance', 'guidance', Number(v.cfg))) done.push('CFG')
              }
              if (typeof v.model === 'string' && v.model.trim()) { if (setIn('model', 'ckpt_name', v.model)) done.push('底模') }
              await writeJsonSafe(path, raw, join(ROOT, 'backups'))
              logger.info?.('dsh-tavern-image: 改了工作流《' + (raw.name ?? file) + '》的 ' + done.join('、'))
              config.workflows = await scanWorkflows(config)
              await loadAllWorkflows()
              sendJson(response, 200, { ok: true, changed: done, values })
              return
            }
            sendJson(response, 200, { ok: true, values })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 试跑一张：用指定的工作流生成一张测试图，确认它能用 ----
        if (action === 'workflow-test') {
          try {
            const file = String(body?.file ?? '')
            const id = String(body?.id ?? '')
            const wf = workflows.find(w => (file && String(w.file).endsWith(file)) || (id && String(w.id) === id))
            if (!wf) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            if (wf.error) { sendJson(response, 400, { ok: false, error: '这张工作流不可用：' + wf.error }); return }
            const prompt = String(body?.prompt ?? '').trim() ||
              '1girl, solo, upper body, simple background, looking at viewer, best quality'
            const job = await startJob({
              tag: prompt,
              rawTag: prompt,
              size: String(body?.size || '方图'),
              model: String(wf.id),      // pickWorkflow 按 id 匹配 → 就用这张
            }, { label: '试跑：' + (wf.label || wf.id), forceWorkflow: wf })
            logger.info?.('dsh-tavern-image: 试跑《' + (wf.label || wf.id) + '》→ ' + job.id.slice(0, 8))
            sendJson(response, 200, { ok: true, jobId: job.id, job: consoleJob(getJob(job.id)), workflow: String(wf.label || wf.id) })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error).slice(0, 400) })
          }
          return
        }

        // ---- 导入工作流（ComfyUI API JSON 或已带 bindings 的格式）----
        if (action === 'workflow-import') {
          try {
            let src = body?.workflow
            if (typeof src === 'string') {
              try { src = JSON.parse(src) } catch { sendJson(response, 400, { ok: false, error: '不是合法的 JSON' }); return }
            }
            const norm = normalizeWorkflow(src, String(body?.name ?? '').trim() || undefined)
            if (!norm) { sendJson(response, 400, { ok: false, error: '没找到 ComfyUI 节点（需要 API 格式的 JSON）' }); return }
            const safe = String(norm.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'imported'
            const file = join(ROOT, 'workflows', safe + '.tavern-comfy-v1.json')
            await writeJsonAtomic(file, norm)
            config.workflows = await scanWorkflows(config)
            await loadAllWorkflows()
            logger.info?.('dsh-tavern-image: 已导入工作流《' + norm.name + '》节点 ' + Object.keys(norm.prompt).length + ' 个')
            sendJson(response, 200, {
              ok: true, name: norm.name, file: safe + '.tavern-comfy-v1.json',
              nodes: Object.keys(norm.prompt).length,
              bindings: {
                positive: norm.bindings.positive.length, negative: norm.bindings.negative.length,
                seed: norm.bindings.seed.length, size: norm.bindings.size.length,
                steps: norm.bindings.steps.length, cfg: norm.bindings.cfg.length,
                model: norm.bindings.model.length, loras: norm.bindings.loras.length,
              },
            })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 读/改某张工作流的 bindings 与 LoRA ----
        if (action === 'workflow-bindings') {
          try {
            const file = String(body?.file ?? '')
            if (!file) { sendJson(response, 400, { ok: false, error: '缺少文件名' }); return }
            const path = join(ROOT, 'workflows', file.replace(/^.*[\\/]/, ''))
            const raw = await readJson(path, null)
            if (!raw) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            if (body?.patch && typeof body.patch === 'object') {
              // 改 LoRA 的启用与权重（按节点 id）
              // 改各类绑定：{ positive: [{node,input}], negative: [...], size/steps/cfg/model/seed 同理 }
              const patchBindings = body.patch.bindings && typeof body.patch.bindings === 'object' ? body.patch.bindings : null
              if (patchBindings) {
                for (const key of ['positive', 'negative', 'seed', 'batch', 'size', 'steps', 'cfg', 'guidance', 'model']) {
                  if (!Array.isArray(patchBindings[key])) continue
                  raw.bindings = raw.bindings ?? {}
                  raw.bindings[key] = patchBindings[key]
                    .filter(x => x && x.node !== undefined)
                    .map(x => ({ node: String(x.node), input: String(x.input ?? 'text') }))
                }
              }
              const patchLoras = Array.isArray(body.patch.loras) ? body.patch.loras : null
              if (patchLoras) {
                const map = new Map(patchLoras.map(x => [String(x.node), x]))
                for (const lora of raw.bindings?.loras ?? []) {
                  const p = map.get(String(lora.node))
                  if (!p) continue
                  if (typeof p.enabled === 'boolean') lora.enabled = p.enabled
                  if (typeof p.name === 'string') lora.name = p.name
                  if (Number.isFinite(Number(p.strengthModel))) lora.strengthModel = Number(p.strengthModel)
                  if (Number.isFinite(Number(p.strengthClip))) lora.strengthClip = Number(p.strengthClip)
                }
              }
              await writeJsonAtomic(path, raw)
            }
            sendJson(response, 200, { ok: true, workflow: raw })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- ComfyUI 里有哪些 LoRA（给导入时选名字用）----
        if (action === 'loras-available') {
          try {
            const base = String(config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
            const r = await fetch(base + '/object_info/LoraLoader', { headers: comfyHeaders(config) }).then(x => x.json()).catch(() => null)
            const names = r?.LoraLoader?.input?.required?.lora_name?.[0] ?? []
            sendJson(response, 200, { ok: true, loras: Array.isArray(names) ? names : [] })
          } catch (error) {
            sendJson(response, 200, { ok: true, loras: [], error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 删除一张历史图 ----
        if (action === 'delete-job') {
          try {
            const id = String(body?.jobId ?? '')
            if (!id) { sendJson(response, 400, { ok: false, error: '缺少 jobId' }); return }
            const job = jobs.get(id)
            job?.controller?.abort()
            if (job?.file) await rm(job.file, { force: true }).catch(() => {})
            // 接住返回值：不存在的话就是 0，别报假成功
            const existed = jobs.delete(id) ? 1 : 0
            persistJobs()
            // 从所有计划里摘掉这个 jobId（重画版本链也要清）
            let touched = 0
            for (const [key, plan] of plansByMessage) {
              const list = plan?.plans
              if (!Array.isArray(list)) continue
              const kept = list.filter(item => String(item.jobId) !== id)
              if (kept.length !== list.length) { plansByMessage.set(key, Object.assign({}, plan, { plans: kept })); touched++ }
            }
            if (touched) persistPlans()
            logger.info?.('dsh-tavern-image: 已删除历史图 ' + id.slice(0, 8))
            sendJson(response, 200, { ok: true, removed: existed, existed: Boolean(existed) })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 导入世界书（接受 ST 格式 / 本插件格式 / 数组 / 纯文本）----
        if (action === 'worldbook-import') {
          try {
            const bookKey = normalizeBookKey(body?.book)
            let src = body?.worldbook
            if (typeof src === 'string') {
              try { src = JSON.parse(src) } catch { /* 当纯文本处理 */ }
            }
            const norm = normalizeWorldbook(src)
            if (!norm || !norm.entries.length) { sendJson(response, 400, { ok: false, error: '没能从这份内容里读出任何条目' }); return }
            // 导入前备份旧的
            try {
              const old = await readJson(join(ROOT, BOOK_KEYS[bookKey]), null)
              if (old) {
                const dir = join(ROOT, 'backups'); await mkdir(dir, { recursive: true })
                await copyFile(join(ROOT, BOOK_KEYS[bookKey]), join(dir, BOOK_KEYS[bookKey].replace(/\.json$/, '') + '-' + Date.now() + '.json'))
              }
            } catch {}
            await queueWorldbookWrite(() => saveOneBook(bookKey, norm))
            worldbookCache = null
            logger.info?.('dsh-tavern-image: 已导入世界书《' + norm.name + '》' + norm.entries.length + ' 条')
            sendJson(response, 200, { ok: true, book: bookKey, name: norm.name, count: norm.entries.length })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 改一条世界书条目（开关 / 改标题 / 改内容 / 删除）----
        if (action === 'worldbook-entry') {
          try {
            const index = Number(body?.index)
            const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {}
            if (patch.activation !== undefined && !['always', 'keywords'].includes(patch.activation)) throw new Error('注入方式只能选常驻或关键词触发')
            if (patch.keywords !== undefined && (!Array.isArray(patch.keywords) || patch.keywords.length > 64 || patch.keywords.some(key => typeof key !== 'string' || key.length > 200))) throw new Error('关键词最多 64 个，每个最多 200 字')
            if (patch.andKeywords !== undefined && (!Array.isArray(patch.andKeywords) || patch.andKeywords.length > 64 || patch.andKeywords.some(key => typeof key !== 'string' || key.length > 200))) throw new Error('附加条件最多 64 个，每个最多 200 字')
            const backendIds = new Set(['comfyui', ...IMAGE_PROVIDERS.map(item => item.id)])
            if (patch.backends !== undefined && (!Array.isArray(patch.backends) || patch.backends.some(id => !backendIds.has(id)))) throw new Error('请选择支持的生图渠道类型')
            const bookKey = normalizeBookKey(body?.book)
    const count = await queueWorldbookWrite(async () => {
      // 编辑必须落在单本上：用合并视图会把第二本的内容写回第一本。
      const wb = await loadOneBook(bookKey)
              if (!Number.isInteger(index) || index < 0 || index >= wb.entries.length) throw new Error('条目不存在')
              if (body?.remove === true) wb.entries.splice(index, 1)
              else {
                const e = wb.entries[index]
                if (typeof patch.comment === 'string') e.comment = patch.comment
                if (typeof patch.content === 'string') e.content = patch.content
                if (typeof patch.enabled === 'boolean') e.enabled = patch.enabled
                Object.assign(e, normalizeEntryActivation({ ...e, ...patch }))
              }
              await saveOneBook(bookKey, wb)
              return wb.entries.length
            })
            sendJson(response, 200, { ok: true, book: bookKey, count })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 新增一条空条目 ----
        if (action === 'worldbook-add') {
          try {
            const bookKey = normalizeBookKey(body?.book)
    const count = await queueWorldbookWrite(async () => {
      const wb = await loadOneBook(bookKey)
              wb.entries.push({ comment: String(body?.comment ?? '新条目'), content: String(body?.content ?? ''), enabled: true, ...normalizeEntryActivation({}) })
              await saveOneBook(bookKey, wb)
              return wb.entries.length
            })
            sendJson(response, 200, { ok: true, book: bookKey, count, index: count - 1 })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 导出当前世界书 ----
        if (action === 'worldbook-export') {
          try {
            const wb = await loadWorldbook()
            sendJson(response, 200, { ok: true, worldbook: wb })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

      if (action === 'config') {
        const patch = body?.config ?? body ?? {}
        try { Object.assign(config, channelConfigPatch(config, patch)) }
        catch (error) { sendJson(response, 400, { ok: false, error: error.message }); return }
        if (patch.imageConcurrency !== undefined) config.imageConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(patch.imageConcurrency)) || 2))
        for (const key of ['comfyUrl', 'defaultWorkflow', 'artistPosition', 'weightMode', 'negativeMode', 'styleArtists', 'imageSize', 'plannerProvider', 'plannerModel', 'plannerExtra', 'traitMode', 'visionProvider', 'visionModel', 'plannerEffort', 'visionEffort', 'comfyAuthMode', 'comfyAuthUser', 'promptManualPositive', 'promptManualNegative']) {
          if (typeof patch[key] === 'string') config[key] = key === 'comfyUrl' ? patch[key].replace(/\/+$/, '') : patch[key]
        }
        // 正文图片显示大小：0 / 空 = 默认（保持原来的显示效果）；数字夹进 160–1200。
        // 非法输入（NaN、负数、乱填的字符串）一律退回默认，绝不让它进配置。
        if (patch.imageDisplayWidth !== undefined) config.imageDisplayWidth = normalizeImageDisplayWidth(patch.imageDisplayWidth)
        // Saved service credentials never round-trip through /state. Blank input
        // means retain the existing value; only an explicit clear flag deletes it.
        if (typeof patch.comfyAuthToken === 'string' && patch.comfyAuthToken !== '') config.comfyAuthToken = patch.comfyAuthToken
        if (typeof patch.comfyAuthPass === 'string' && patch.comfyAuthPass !== '') config.comfyAuthPass = patch.comfyAuthPass
        if (patch.clearComfyAuthToken === true) config.comfyAuthToken = ''
        if (patch.clearComfyAuthPass === true) config.comfyAuthPass = ''
        for (const key of ['lockWorkflow', 'overrideSteps', 'autoImageGen', 'plannerEnabled', 'jpegOutput', 'smartImageSelection', 'characterAutoUpdate']) if (typeof patch[key] === 'boolean') config[key] = patch[key]
        if (typeof patch.promptMode === 'string' && ['auto', 'tags', 'natural', 'mixed'].includes(patch.promptMode)) config.promptMode = patch.promptMode
        if (typeof patch.activePromptPreset === 'string') config.activePromptPreset = patch.activePromptPreset.slice(0, 80)
        if (Array.isArray(patch.promptPresets)) config.promptPresets = normalizePromptPresets(patch.promptPresets)
        config.activePromptPreset = validPromptPresetId(config)
        if (patch.jpegQuality !== undefined) config.jpegQuality = Math.max(50, Math.min(100, Math.round(Number(patch.jpegQuality) || 88)))
        if (typeof patch.jpegBackground === 'string') config.jpegBackground = /^#?[0-9a-f]{6}$/i.test(patch.jpegBackground.trim()) ? (patch.jpegBackground.trim().startsWith('#') ? patch.jpegBackground.trim() : '#' + patch.jpegBackground.trim()) : '#ffffff'
        for (const key of ['promptManualPositive', 'promptManualNegative']) if (typeof patch[key] === 'string') config[key] = patch[key].slice(0, 4000)
        if (patch.comfyMode === 'simple' || patch.comfyMode === 'workflow') config.comfyMode = patch.comfyMode
        if (patch.comfySimple && typeof patch.comfySimple === 'object' && !Array.isArray(patch.comfySimple)) config.comfySimple = normalizeComfySimpleConfig({ ...config.comfySimple, ...patch.comfySimple })
        if (typeof patch.traitMode === 'string' && ['auto', 'sfw', 'all'].includes(patch.traitMode)) config.traitMode = patch.traitMode
        // 兼容旧字段名（画师串多套）
        if (Array.isArray(patch.artistSets)) {
          config.artistSets = patch.artistSets.filter(x => x && typeof x === 'object').slice(0, 60).map((x, i) => ({
            id: String(x.id ?? ('set' + i)), name: String(x.name ?? ('画师串 ' + (i + 1))).slice(0, 60),
            text: String(x.text ?? '').slice(0, 4000),
            position: x.position === 'suffix' ? 'suffix' : 'prefix',
            enabled: x.enabled !== false,
          }))
        }
        if (typeof patch.activeArtistSet === 'string') config.activeArtistSet = patch.activeArtistSet.slice(0, 60)
        if (Array.isArray(patch.styleArtists)) config.styleArtists = String(patch.styleArtists[0] ?? '')
        if (patch.plannerCount !== undefined) config.plannerCount = Math.max(1, Math.min(8, Number(patch.plannerCount) || 3))
        if (patch.plannerTemperature !== undefined) config.plannerTemperature = Number(patch.plannerTemperature) || 1
        if (Array.isArray(patch.plannerEntries)) config.plannerEntries = patch.plannerEntries.map(Number)
        // 画风预设（数组，要单独处理 —— 上面的 string/boolean 白名单收不了）
        if (Array.isArray(patch.stylePresets)) {
          config.stylePresets = patch.stylePresets
            .filter(x => x && typeof x === 'object')
            .slice(0, 60)
            .map((x, i) => ({
              id: String(x.id ?? ('preset' + i)),
              name: String(x.name ?? ('画风 ' + (i + 1))).slice(0, 60),
              artist: String(x.artist ?? '').slice(0, 4000),
              negative: String(x.negative ?? '').slice(0, 2000),
              position: x.position === 'suffix' ? 'suffix' : 'prefix',
              enabled: x.enabled !== false,
              params: normalizePresetParams(x.params),
            }))
        }
        if (typeof patch.activePreset === 'string') config.activePreset = patch.activePreset.slice(0, 60)
        if (typeof patch.styleNegative === 'string') config.styleNegative = patch.styleNegative.slice(0, 2000)
        if (patch.imageGenCount !== undefined) config.imageGenCount = Math.max(1, Math.min(6, Number(patch.imageGenCount) || 2))
        if (patch.injectWeight !== undefined) config.injectWeight = Number(patch.injectWeight) || 0
        if (patch.sizes && typeof patch.sizes === 'object') config.sizes = patch.sizes
        await saveConfig(config)
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'workflow') {
        const id = String(body?.id ?? '')
        const target = config.workflows.find(item => String(item.id) === id)
        if (!target) { sendJson(response, 404, { ok: false, error: '没有这个工作流条目' }); return }
        if (body.label !== undefined) target.label = String(body.label)
        if (body.match !== undefined) target.match = Array.isArray(body.match) ? body.match.map(String) : splitTags(String(body.match))
        if (body.sizes !== undefined) target.sizes = body.sizes && typeof body.sizes === 'object' ? body.sizes : null
        if (body.enabled !== undefined) target.enabled = Boolean(body.enabled)
        if (body.remove === true) config.workflows = config.workflows.filter(item => String(item.id) !== id)
        await saveConfig(config)
        await loadAllWorkflows()
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'reload') {
        config.workflows = await scanWorkflows(config)
        await loadAllWorkflows()
        definitions = await loadDefinitions()
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      // ═══ 服装库生成（按偏好 / 批量 / 支持任意年龄段的 nsfw）═══
  if (action === 'generate-outfits' || action === 'generate-outfits-bulk') {
    const bulk = action === 'generate-outfits-bulk'
    const preference = String(body?.preference ?? '').slice(0, 500)
    const ageBand = String(body?.ageBand ?? 'adult')
    const nsfw = body?.nsfw === true
    const clamped = clampBatchCount(body?.count ?? 3, body?.maxTotal ?? 60)
    const wanted = bulk
      ? (Array.isArray(body?.characterIds) ? body.characterIds.map(String).filter(Boolean) : [])
      : (body?.characterId ? [String(body.characterId)] : [])
    if (!wanted.length) {
      sendJson(response, 400, { ok: false, error: bulk ? '没有指定角色（characterIds）' : '没有指定角色（characterId）' })
      return
    }
    if (bulk && wanted.length * clamped.perCharacter > clamped.maxTotal) {
      sendJson(response, 400, {
        ok: false,
        error: '一次批量最多产 ' + clamped.maxTotal + ' 套，当前 ' + wanted.length + ' 个角色 × ' + clamped.perCharacter + ' 套超额。请减少角色数或每角色套数。',
      })
      return
    }
    try {
      const fallback = await backgroundModel(lastSessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      if (!provider || !model) {
        sendJson(response, 400, { ok: false, error: '没定用哪个模型：Tavern 后台模型是空的，就来插件设置里指定一个' })
        return
      }
      const definitions = await loadDefinitions()
      const characters = Array.isArray(definitions.characters) ? definitions.characters : []
      const results = []
      const missing = []
      for (const key of wanted) {
        const character = characters.find(c => c && (c.id === key || c.name === key))
        if (!character) { missing.push(key); continue }
        const prompt = buildOutfitPrompt({ character, preference, count: clamped.perCharacter, ageBand, nsfw })
        let text = ''
        try {
          const result = await runPlanner(deps.llm, {
            provider,
            model,
            reasoningEffort: plannerEffortFor(fallback),
            system: prompt.system,
            text: prompt.text,
            temperature: 0.95,
          })
          text = String(result?.text ?? '')
        } catch (error) {
          results.push({ character: character.name, ok: false, error: (error?.message ?? String(error)).slice(0, 200) })
          continue
        }
        const parsed = parseOutfits(text)
        const merged = mergeOutfits(character.outfits, parsed.outfits)
        // 只对这一个角色赋值，其余角色对象原样保留；saveDefinitions 的防清空闸门兜底。
        character.outfits = merged.outfits
        results.push({
          character: character.name,
          ok: merged.added > 0,
          added: merged.added,
          skipped: merged.skipped,
          dropped: parsed.dropped,
          total: merged.outfits.length,
          nsfwCount: merged.outfits.filter(o => o && o.nsfw === true).length,
          sample: merged.outfits.slice(-merged.added).map(o => o.name).filter(Boolean),
          ...(merged.added ? {} : { raw: text.slice(0, 600) }),
        })
      }
      if (!results.some(r => r.ok)) {
        sendJson(response, 400, {
          ok: false,
          error: '没有产出可用的服装',
          missing,
          results,
        })
        return
      }
      const saved = await saveDefinitions(definitions)
      if (saved === false) {
        sendJson(response, 500, { ok: false, error: '保存被拒绝（防清空闸门），未写入' })
        return
      }
      sendJson(response, 200, {
        ok: true,
        bulk,
        preference,
        ageBand,
        nsfw,
        perCharacter: clamped.perCharacter,
        results,
        missing,
      })
      return
    } catch (error) {
      sendJson(response, 500, { ok: false, error: (error?.message ?? String(error)).slice(0, 400) })
      return
    }
  }

  // ═══ 从卡片风格批量生成未成年 NSFW 角色 ═══
  // 原型取人物库里已有的角色（同世界风格参照），风格取当前卡的设定摘要。
  // 每个角色都带完整 NSFW 分块（正/背面 × SFW/NSFW 四处），生图时四个视角都能调。
  if (action === 'generate-characters-minor') {
    const ageBand = String(body?.ageBand ?? 'child')
    const age = body?.age ?? ''
    const preference = String(body?.preference ?? '').slice(0, 500)
    const wanted = Math.max(1, Math.min(12, Number.isFinite(Number(body?.count)) ? Math.trunc(Number(body?.count)) : 3))
    try {
      const sessionId = String(body?.sessionId ?? lastSessionId ?? '')
      const definitions = await loadDefinitions()
      const existing = Array.isArray(definitions.characters) ? definitions.characters : []

      let cardName = ''
      let cardContext = ''
      let prototypes = []

      // 优先用「指定的卡」：人物库里的「从选定的卡生成」会把卡片文件名传进来。
      // 读那张卡的设定当风格依据，卡里的角色当原型；读不到再退回当前游玩卡。
      const wantedCard = String(body?.card ?? '').trim()
      if (wantedCard) {
        try {
          const cardDir = join(TAVERN_DATA, 'resources', 'cards')
          const fileName = wantedCard.replace(/^cards[\/\\]/, '')
          const payload = await readJson(join(cardDir, fileName), null)
          const raw = payload?.raw ?? payload ?? null
          if (raw) {
            cardName = String(raw.name ?? fileName.replace(/\.json$/i, ''))
            cardContext = [raw.description, raw.personality, raw.scenario, raw.mes_example]
              .map(v => String(v ?? '')).filter(Boolean).join('\n')
            const fromBook = charactersFromCardBook(raw)
            if (fromBook.length) prototypes = fromBook.slice(0, 12)
          }
        } catch (error) {
          logger.warn?.('dsh-tavern-image: 读卡失败 ' + wantedCard + ' ' + (error?.message ?? error))
        }
      }

      // 没指定卡（或那张卡读不出来）时，退回当前游玩卡 + 人物库已有角色
      if (!cardContext) {
        const card = await currentCard(sessionId)
        const ctx = await cardContextRaw(sessionId)
        cardName = cardName || String(card?.name ?? '')
        cardContext = ctx
          ? [ctx.description, ctx.personality, ctx.scenario].map(v => String(v ?? '')).filter(Boolean).join('\n')
          : ''
      }
      if (!prototypes.length) prototypes = existing.slice(0, 12)

      // 卡里的原型可能跟人物库重名，去掉重复的（不覆盖已有角色）
      const existingNames = new Set(existing.map(c => String(c?.name ?? '').trim()).filter(Boolean))
      prototypes = prototypes.filter(p => !existingNames.has(String(p?.name ?? '').trim()))

      const fallback = await backgroundModel(sessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      if (!provider || !model) {
        sendJson(response, 400, { ok: false, error: '没定用哪个模型：Tavern 后台模型是空的，就来插件设置里指定一个' })
        return
      }

      const prompt = buildMinorBatchPrompt({
        prototypes,
        cardName,
        cardContext,
        count: wanted,
        ageBand,
        age,
        preference,
        existing,
      })

      let text = ''
      try {
        const result = await runPlanner(deps.llm, {
          provider,
          model,
          reasoningEffort: plannerEffortFor(fallback),
          system: prompt.system,
          text: prompt.text,
          temperature: 0.95,
        })
        text = String(result?.text ?? '')
      } catch (error) {
        sendJson(response, 500, { ok: false, error: '模型调用失败：' + (error?.message ?? String(error)).slice(0, 300) })
        return
      }

      const parsed = parseCharacters(text)
      const cleaned = scrubMinorNegatives(parsed.characters)
      if (!cleaned.length) {
        sendJson(response, 400, {
          ok: false,
          error: '没有解析出可用角色',
          dropped: parsed.dropped,
          raw: text.slice(0, 800),
        })
        return
      }

      const merged = mergeCharacters(existing, cleaned)
      const saved = await saveDefinitions(Object.assign({}, definitions, { characters: merged.characters }))
      if (saved === false) {
        sendJson(response, 500, { ok: false, error: '保存被拒绝（防清空闸门），未写入' })
        return
      }

      sendJson(response, 200, {
        ok: true,
        ageBand: prompt.ageBand,
        age: prompt.age,
        count: cleaned.length,
        added: merged.report?.added ?? 0,
        updated: merged.report?.updated ?? 0,
        skipped: merged.report?.skipped ?? 0,
        dropped: parsed.dropped,
        card: cardName,
        characters: cleaned.map(c => ({
          name: c.name,
          nsfwBlocks: ['bodyNSFW', 'bodyNSFWBack', 'lowerNSFW', 'lowerNSFWBack'].filter(k => c.traits?.[k]).length,
          outfits: (c.outfits || []).length,
          nsfwOutfits: (c.outfits || []).filter(o => o.nsfw).length,
        })),
      })
      return
    } catch (error) {
      sendJson(response, 500, { ok: false, error: (error?.message ?? String(error)).slice(0, 400) })
      return
    }
  }

  if (action === 'definitions') {
        const next = body?.definitions ?? {}
        // ⚠ 防护（2026-10-07）：曾经有一次前端/脚本带着空数组调用这个接口，
        //   把用户辛苦建的角色一次性清光。现在：新数据为空而现有数据非空时直接拒绝。
        const curChars = Array.isArray(definitions?.characters) ? definitions.characters : []
        const curOutfits = Array.isArray(definitions?.outfits) ? definitions.outfits : []
        // 缺省字段保留旧库；只有显式数组才替换，兼容只编辑人物的客户端。
        const nextChars = Array.isArray(next.characters) ? next.characters : curChars
        const nextOutfits = Array.isArray(next.outfits) ? next.outfits : curOutfits
        if (nextChars.length === 0 && curChars.length > 0) {
          sendJson(response, 200, {
            ok: false,
            error: '拒绝把 ' + curChars.length + ' 个角色清空（提交里 characters 为空）。若确实要清空，请先删到只剩 1 个。',
            refused: 'would-empty-characters',
          })
          return
        }
        if (nextOutfits.length === 0 && curOutfits.length > 0 && nextChars.length === 0) {
          sendJson(response, 200, {
            ok: false,
            error: '拒绝清空服装库（提交里 outfits 为空且没有携带角色数据）。',
            refused: 'would-empty-outfits',
          })
          return
        }
        definitions = {
          version: 3,
          characters: nextChars.map((item, i) => normalizeDefinition('characters', item, i)),
          settings: (Array.isArray(next.settings) ? next.settings : definitions.settings).map((item, i) => normalizeDefinition('settings', item, i)),
          props: (Array.isArray(next.props) ? next.props : definitions.props).map((item, i) => normalizeDefinition('props', item, i)),
          outfits: nextOutfits.map((item, i) => normalizeOutfit(item, i)),
        }
        await saveDefinitions(definitions)
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'import-characters') {
        try {
          // 扫会话数据，收集世界书正文（模型请求优先，聊天分块兜底）
          const texts = []
          const seen = new Set()
          const reqFiles = []
          const chatFiles = []
          const walkJson = async (dir, bucket, depth = 0) => {
            if (depth > 3) return
            const names = await readdir(dir).catch(() => [])
            for (const name of names) {
              const full = join(dir, name)
              const info = await stat(full).catch(() => null)
              if (!info) continue
              if (info.isDirectory()) { await walkJson(full, bucket, depth + 1); continue }
              if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
              if (info.size > 3_000_000) continue
              bucket.push({ full, mtimeMs: info.mtimeMs })
            }
          }
          await walkJson(join(TAVERN_DATA, 'model-requests'), reqFiles)
          await walkJson(join(TAVERN_DATA, 'chats'), chatFiles)
          reqFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
          chatFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
          let scannedFiles = 0
          for (const file of [...reqFiles.slice(0, 30), ...chatFiles.slice(0, 10)]) {
            if (texts.join('').length > 120_000) break
            scannedFiles += 1
            const payload = await readJson(file.full, null).catch(() => null)
            if (!payload) continue
            const collect = (node, depth = 0) => {
              if (depth > 8 || !node || typeof node !== 'object') return
              for (const value of Object.values(node)) {
                if (typeof value === 'string') {
                  if (value.length > 400 && (value.includes('常驻世界书') || (value.includes('姓名') && value.includes('年龄')))) {
                    const key = value.slice(0, 64)
                    if (!seen.has(key)) { seen.add(key); texts.push(value) }
                  }
                } else if (value && typeof value === 'object') {
                  collect(value, depth + 1)
                }
              }
            }
            collect(payload)
          }

          // 角色卡里的 character_book 就是这张卡的世界书。
          // 先确定"当前卡"，避免把别的卡的人一起导进来。
          const cardDir = join(TAVERN_DATA, 'resources', 'cards')
          const cardFiles = await readdir(cardDir).catch(() => [])
          const loadedCards = []
          for (const name of cardFiles) {
            if (!name.endsWith('.json')) continue
            const payload = await readJson(join(cardDir, name), null).catch(() => null)
            if (!payload) continue
            const raw = payload.raw ?? payload
            const book = raw?.character_book ?? raw?.characterBook ?? raw?.data?.character_book ?? null
            const entries = Array.isArray(book?.entries) ? book.entries : []
            const blob = [
              ...entries.map(e => String(e?.content ?? e?.text ?? '')),
              String(raw?.description ?? ''), String(raw?.scenario ?? ''),
              String(raw?.first_mes ?? ''), String(raw?.mes_example ?? ''),
            ].join('\n')
            loadedCards.push({ file: name, name: String(raw?.name ?? ''), raw, entries, blob, mtimeMs: (await stat(join(cardDir, name)).catch(() => null))?.mtimeMs ?? 0 })
          }

          // 当前会话最近一轮的正文，用来判定这张卡
          const bodySession = String(body?.sessionId ?? '').trim()
          const sessions = [...lastTurn.keys()]
          const activeGame = bodySession || sessions[0] || ''
          const activeTurn = activeGame ? lastTurn.get(activeGame) : 0
          let turnText = ''
          if (activeGame && deps.tavern && typeof deps.tavern.getTurn === 'function') {
            const snap = await deps.tavern.getTurn({ gameId: activeGame, turn: activeTurn }).catch(() => null)
            const pick = node => {
              if (!node || typeof node !== 'object') return ''
              let out = ''
              for (const v of Object.values(node)) {
                if (typeof v === 'string') out += v + '\n'
                else if (v && typeof v === 'object') out += pick(v)
              }
              return out
            }
            turnText = pick(snap).slice(0, 20000)
          }

          // 选卡：优先"正文里出现该卡角色名最多"的，其次最新修改的
          // 会话为空时，用"最近活跃的聊天"来认卡：聊天块里带着卡名和人物
          let chatBlob = ''
          let activeChat = ''
          if (!activeGame || !turnText) {
            const chatRoot = join(TAVERN_DATA, 'chats')
            const chatDirs = await readdir(chatRoot).catch(() => [])
            let newestChat = null
            for (const name of chatDirs) {
              const info = await stat(join(chatRoot, name)).catch(() => null)
              if (info && (!newestChat || info.mtimeMs > newestChat.mtimeMs)) newestChat = { name, mtimeMs: info.mtimeMs }
            }
            if (newestChat) {
              activeChat = newestChat.name
              const files = []
              const walk = async (dir, depth = 0) => {
                if (depth > 2) return
                const names = await readdir(dir).catch(() => [])
                for (const n of names) {
                  const full = join(dir, n)
                  const info = await stat(full).catch(() => null)
                  if (!info) continue
                  if (info.isDirectory()) { await walk(full, depth + 1); continue }
                  if (n.endsWith('.json') && info.size < 3_000_000) files.push({ full, mtimeMs: info.mtimeMs })
                }
              }
              await walk(join(chatRoot, newestChat.name))
              files.sort((a, b) => b.mtimeMs - a.mtimeMs)
              for (const file of files.slice(0, 12)) {
                const payload = await readJson(file.full, null).catch(() => null)
                if (!payload) continue
                try { chatBlob += JSON.stringify(payload) } catch {}
                if (chatBlob.length > 200000) break
              }
            }
          }

          // 用 Tavern 的卡上下文锁定当前卡（比猜名字可靠）
          let contextBlob = ''
          const ctxInfo = { has: false, keys: [], len: 0 }
          if (activeGame && deps.tavern && typeof deps.tavern.getCardContext === 'function') {
            const ctx = await deps.tavern.getCardContext({ gameId: activeGame, turn: activeTurn }).catch(() => null)
            if (ctx) {
              ctxInfo.has = true
              ctxInfo.keys = typeof ctx === 'object' ? Object.keys(ctx).slice(0, 12) : []
              try { contextBlob = JSON.stringify(ctx).slice(0, 200000) } catch { contextBlob = '' }
              ctxInfo.len = contextBlob.length
            }
          }

          const probeBlob = contextBlob || chatBlob
          const wantCard = String(body?.card ?? '').trim()
          let chosen = null
          if (wantCard) {
            const base = wantCard.split(/[\\/]/).pop() || ''
            chosen = loadedCards.find(card => card.file === base || card.name === wantCard || card.file === wantCard + '.json') || null
          }
          // 使用者明确选了卡：只读这张卡。前面从最近的模型请求、聊天里扫到的世界书正文
          // 可能来自别的卡（最近玩过的卡），一并丢掉，否则会把别的卡的人导进来。
          const explicitCard = Boolean(chosen)
          if (explicitCard) { texts.length = 0; seen.clear() }
          if (!chosen && probeBlob) {
            // 卡名出现在聊天内容里 → 精确命中；同时用角色名打分兜底
            const byName = loadedCards.filter(card => {
              const n = String(card.name || '').trim()
              return n.length >= 3 && probeBlob.includes(n)
            }).sort((a, b) => String(b.name).length - String(a.name).length)
            if (byName.length) chosen = byName[0]
          }
          if (!chosen && loadedCards.length) {
            const scored = loadedCards.map(card => {
              let score = 0
              if (probeBlob) {
                const names = new Set()
                for (const e of card.entries) {
                  const m = /姓名\s*[:：]\s*([^\n]{2,12})/.exec(String(e?.content ?? ''))
                  if (m) names.add(m[1].trim())
                }
                for (const n of names) if (probeBlob.includes(n)) score += 1
              }
              return { card, score }
            }).sort((a, b) => (b.score - a.score) || (b.card.mtimeMs - a.card.mtimeMs))
            chosen = scored[0].score > 0 ? scored[0].card : loadedCards.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
          }
          let cardScanned = 0
          if (chosen) {
            cardScanned = 1
            for (const entry of chosen.entries) {
              const content = String(entry?.content ?? entry?.text ?? '')
              if (content.length > 200 && (content.includes('姓名') || (explicitCard && /名称|名字/.test(content) && /年龄|外貌|外表|长相/.test(content)))) {
                const key = content.slice(0, 64)
                if (!seen.has(key)) { seen.add(key); texts.push(content) }
              }
            }
          }

          const worldbookText = texts.join('\n')
          let found = charactersFromWorldbookText(worldbookText)

          // 规则抽不到时让规划模型读一遍世界书
          if (found.length < 3 && worldbookText.trim()) {
            try {
              const provider = config.plannerProvider || ''
              const model = config.plannerModel || ''
              if (deps.llm && provider && model) {
                const EXTRACT_SYSTEM = [
                  '你是角色卡提取器。用户会给你一段中文世界书，里面用「姓名 / 年龄 / 身份关系 / 职业 / 简介」的 YAML 结构描述人物。',
                  '把里面所有人物都提取成 JSON，只输出 JSON，不要解释。',
                  '要求：',
                  '1. 只输出 {"characters":[{"name","age","identity","feature","body","outfit","note"}]}',
                  '2. 年龄小于 18 岁的角色一律跳过。',
                  '3. 只保留看得见的外观：发色发型、五官、身高、体型、身材比例、常穿服装；剧情、家庭关系不要写进 feature。',
                  '4. 体积词改比例词：巨乳→胸型饱满，肥臀→臀部圆润，赘肉→线条紧实。',
                  '5. 年龄按档位下压：18-22→十八九岁，23-28→二十五六岁，29-34→二十七八岁，35-42→三十出头，43-50→三十五岁左右，50 以上→四十出头。',
                  '6. feature 60-120 字，body 20-50 字，note 15 字以内。',
                ].join('\n')
                const output = await runPlanner(deps.llm, {
                  provider, model, system: EXTRACT_SYSTEM,
                  text: worldbookText.slice(0, 24000), temperature: 0.2, maxTokens: 8000,
                })
                const rawText = typeof output === 'string' ? output : String(output?.text ?? '')
                const extracted = charactersFromExtraction(rawText)
                if (extracted.length) found = [...extracted, ...found]
              }
            } catch { /* 模型不可用就用规则结果 */ }
          }

          // 选定的卡用规则和模型都没抽到人时，按卡世界书的条目名再认一遍
          if (explicitCard && !found.length && chosen?.raw) found = charactersFromCardBook(chosen.raw)
          // 未满 18 岁的人物不建生图设定：按这张卡里写着这个名字的条目判断年龄
          const sourceEntries = chosen ? chosen.entries : []
          const isMinor = person => {
            const name = String(person?.name ?? '').trim()
            const own = [String(person?.traits?.feature ?? '')]
            for (const entry of sourceEntries) {
              const title = String(entry?.comment ?? entry?.name ?? '')
              const keys = Array.isArray(entry?.keys) ? entry.keys.map(String) : []
              if (name && (title.includes(name) || keys.includes(name))) own.push(String(entry?.content ?? entry?.text ?? '').slice(0, 1500))
            }
            return own.some(text => {
              const age = /年龄\s*[:：]?\s*(\d{1,2})\s*岁?/.exec(text)
              return (age && Number(age[1]) < 18) || /未成年|初中生|小学生|高中生/.test(text.slice(0, 400))
            })
          }
          const skippedMinors = found.filter(isMinor).map(person => person.name)
          found = found.filter(person => !isMinor(person))
          // 从选定的卡导入的新人物绑定到这张卡，只在这张卡里生效，不串到别的卡
          if (explicitCard) found = found.map(person => Object.assign({}, person, { cards: (person.cards || []).length ? person.cards : ['cards/' + chosen.file] }))
          const existing = Array.isArray(definitions?.characters) ? definitions.characters : []
          const merged = mergeCharacters(existing, found)
          definitions = Object.assign({}, definitions, { characters: merged.characters })
          await saveDefinitions(definitions)
          sendJson(response, 200, {
            ok: true,
            added: merged.report.added,
            updated: merged.report.updated,
            skipped: merged.report.skipped,
            skippedMinors,
            scanned: explicitCard ? 0 : scannedFiles,
            cards: cardScanned,
            cardName: chosen ? (chosen.name || chosen.file) : '',
            session: activeGame,
            turn: activeTurn,
            turnTextLength: turnText.length,
            ctxInfo,
            activeChat,
            chatBlobLength: chatBlob.length,
            candidates: loadedCards.slice(0, 5).map(card => ({ name: card.name || card.file, entries: card.entries.length })),

            texts: texts.length,
            state: await consoleState(),
          })
          return
        } catch (error) {
          sendJson(response, 200, { ok: false, error: '导入失败：' + String(error?.message ?? error).slice(0, 200) })
          return
        }
      }

      if (action === 'img') {
        // 给卡里的显示正则用：/img?key=<jobId 前 8 位>
        try {
          const key = String(_url?.searchParams?.get('key') ?? '').toLowerCase()
          let hit = null
          for (const job of jobs.values()) {
            if (String(job.id).toLowerCase().startsWith(key) && key.length >= 6) { hit = job; break }
          }
          if (!hit) { sendJson(response, 404, { ok: false, error: '没有这个插图' }); return }
          if (hit.state !== 'done' || !hit.byteLength) { sendJson(response, 404, { ok: false, error: '这张还没画好' }); return }
          sendImage(response, hit, request.headers.range)
        } catch (error) {
          sendJson(response, 404, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'cards') {
        try {
          const dir = join(TAVERN_DATA, 'resources', 'cards')
          const names = await readdir(dir).catch(() => [])
          const cards = []
          for (const name of names.filter(n => /\.json$/i.test(n))) {
            const payload = await readJson(join(dir, name), null).catch(() => null)
            const raw = payload?.raw ?? payload ?? null
            const title = String(raw?.name ?? '').trim()
            cards.push({ path: 'cards/' + name, name: name.replace(/\.json$/i, ''), title: title || name.replace(/\.json$/i, '') })
          }
          cards.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
          sendJson(response, 200, { ok: true, cards })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'job-detail') {
        const job = getJob(String(_url?.searchParams?.get('id') ?? ''))
        if (!job) { sendJson(response, 404, { ok: false, error: '没有这个作业' }); return }
        sendJson(response, 200, { ok: true, job: consoleJob(job) })
        return
      }

      if (action === 'redraw') {
        try {
          const src = getJob(String(body?.jobId ?? ''))
          if (!src) { sendJson(response, 404, { ok: false, error: '找不到原图' }); return }
          // 按原图所属的那局判断人物可用性，并沿用原图那一轮的人物状态（当前穿着、永久外貌变化）；
          // 尺寸、步数、CFG、画师串位置也跟原图一致。以前只带提示词和工作流：横图重画成竖图，
          // 宏里没写衣服的图按人物库默认穿着重画。
          const session = String(src.gameId || body?.sessionId || lastSessionId || '')
          const card = await currentCard(session)
          const timeline = applyCharacterSnapshot(definitions, src.characterSnapshot)
          const defs = { ...timeline, characters: (timeline.characters ?? []).filter(character => usableOnCard(character, card)) }
          const askedRaw = String(body?.prompt ?? src.params?.rawTag ?? src.params?.tag ?? '')
          const fresh = await startJob({
            tag: normalizePrompts(expandRosterCalls(askedRaw, defs, config.traitMode, { style: rosterStyle(config, styleWorkflow(config, src.workflowId)) }), defs, { backend: config.imageBackend, style: rosterStyle(config, styleWorkflow(config, src.workflowId)) }),
            rawTag: askedRaw,
            artist: src.params?.artist,
            artistPosition: src.params?.artistPosition,
            negative: String(body?.negative ?? src.params?.negative ?? ''),
            size: src.params?.size,
            steps: src.params?.steps,
            cfg: src.params?.cfg,
            model: src.workflowId,
            ...(src.characterSnapshot ? { characterSnapshot: src.characterSnapshot } : {}),
            ...(src.textVersion ? { textVersion: src.textVersion } : {}),
            ...(session ? { sessionId: session } : {}),
            ...(src.turn != null ? { turn: src.turn } : {}),
          }, { label: '重画' })
          logger.info?.('dsh-tavern-image: 重画 ' + src.id.slice(0, 8) + ' → ' + fresh.id.slice(0, 8))
          sendJson(response, 200, { ok: true, jobId: fresh.id, job: consoleJob(fresh) })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'improve-prompt') {
        try {
          const src = getJob(String(body?.jobId ?? ''))
          const current = String(body?.prompt ?? src?.positive ?? '')
          const instruction = String(body?.instruction ?? '')
          // 和 planMessage 一样：没单独指定就跟随 Tavern 的默认后台模型
          const fallback = await backgroundModel(body?.sessionId ?? lastSessionId)
          const provider = String(config.plannerProvider || fallback?.provider || '')
          const model = String(config.plannerModel || fallback?.model || '')
          if (!provider || !model) { sendJson(response, 400, { ok: false, error: '还没选规划用的模型，且 Tavern 设置里也没有「默认后台模型」（设置页 → 规划）' }); return }
          const system = [
            '你是绘图提示词编辑。',
            '只输出修改后的英文 Tag 串，一行，不要解释、不要加引号、不要换行。',
            '保留原有的人物身份与画风 Tag，只按用户要求增删调整。',
          ].join('\n')
          const ask = [
            '现有提示词：',
            current,
            '',
            '用户要求：' + (instruction || '让画面更贴合剧情、细节更丰富'),
            '',
            '只输出修改后的提示词。',
          ].join('\n')
          const out = await runPlanner(deps.llm, { provider, model, reasoningEffort: plannerEffortFor(fallback), system, text: ask, maxTokens: 1200, temperature: 0.7 })
          const next = String(out?.text ?? '').split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
          if (!next) { sendJson(response, 400, { ok: false, error: '模型没返回内容' }); return }
          sendJson(response, 200, { ok: true, prompt: next })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'report') {
        try {
          addClientReport({
            at: Date.now(),
            stage: String(body?.stage ?? 'unknown').slice(0, 80),
            data: body?.data ?? null,
          })
        } catch { /* 报告失败不影响前端 */ }
        sendJson(response, 200, { ok: true })
        return
      }

      if (action === 'cancel') {
        const id = String(body?.id ?? '')
        if (getJob(id)) sendJson(response, 200, { ok: true, job: cancelJob(id) })
        else sendJson(response, 200, { ok: cancelTask(id) })
        return
      }

      if (action === 'design') {
        try {
          try { addClientReport({ at: Date.now(), stage: 'design-received', data: { hasCurrent: Boolean(body?.current), name: String(body?.current?.name ?? ''), briefLen: String(body?.brief ?? '').length } }) } catch {}
          const designed = await designCharacters({
            brief: String(body?.brief ?? ''),
            sessionId: String(body?.sessionId ?? lastSessionId ?? ''),
            useCard: body?.useCard !== false,
            photo: body?.data ? { data: body.data, mediaType: body.mediaType, name: body.name } : null,
            current: body?.current && typeof body.current === 'object' ? body.current : null,
          })
          sendJson(response, 200, { ok: true, people: designed.people, raw: designed.raw })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'vision') {
        try {
          const described = await describePhoto({
            data: body?.data, mediaType: body?.mediaType, name: body?.name, sessionId: body?.sessionId,
          })
          sendJson(response, 200, described)
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'plan') {
        if (!String(body?.text ?? '').trim() && body?.sessionId) {
          const fromSession = messageTextFrom(String(body.sessionId), String(body?.messageId ?? ''))
          if (fromSession) body.text = fromSession
        }
        try {
          const plan = await planMessage({
            text: String(body?.text ?? ''),
            messageId: String(body?.messageId ?? ''),
            turn: body?.turn,
            count: body?.count,
            sessionId: String(body?.sessionId ?? lastSessionId ?? ''),
            manual: body?.manual === true,
          })
          sendJson(response, 200, { ok: true, plan, plans: plan.plans, raw: plan.raw ?? '', error: plan.error ?? null })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'generate') {
        try {
          const job = await startJob({
            tag: String(body?.tag ?? ''), artist: String(body?.artist ?? ''), negative: String(body?.negative ?? ''),
            size: String(body?.size ?? '竖图'), model: String(body?.workflow ?? ''),
          }, { label: '控制台试画' })
          sendJson(response, 200, { ok: true, jobId: job.id, job })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      sendJson(response, 404, { ok: false, error: 'not-found' })
    }



    return {
      consoleHtml, consoleState, handleConsole, readBody, sendImage,
      startJob, startReplacement, cancelJob, refresh, getJob: id => (id ? getJob(id) : null), findJob, publicJob,
      planFromTool, planMessage,
      currentConfig: () => config,
      // 手动配图：读这一轮的 textVersion 与正文，再交给官方桥 attach
      attachTurn: async ({ gameId, turn }) => {
        // 桥是异步装配的（要等 runtime 起来），用户手快时它可能还没就绪 —— 最多等 20 秒
        for (let waited = 0; !deps.bridge?.attachTurn && waited < 20000; waited += 200) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        if (!deps.bridge?.attachTurn) return { attached: 0, error: 'Tavern 官方接口桥未安装（当前 Tavern 可能没有插件接口）' }
        if (!deps.tavern || typeof deps.tavern.getTurn !== 'function') return { attached: 0, error: '当前 Tavern 没有 tavern.getTurn' }
        const key = JSON.stringify([String(gameId), Number(turn)])
        let wait = settledTurnWaits.get(key)
        let settled
        let waited = Boolean(wait)
        if (wait) settled = await wait
        else {
          settled = await deps.tavern.getTurn({ gameId, turn })
          if (!settled) {
            wait = settledTurnWaits.get(key)
            if (wait) {
              waited = true
              settled = await wait
            }
          }
          if (!settled && !wait) {
            waited = true
            const controller = new AbortController()
            settledTurnWaitControllers.add(controller)
            const pending = (async () => {
              const deadline = Date.now() + 120000
              while (!controller.signal.aborted && !imageDisposed && Date.now() < deadline) {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(done, 1000)
                  function done() { cleanup(); resolve() }
                  function abort() { cleanup(); reject(controller.signal.reason || new Error('等待正文时插件已卸载')) }
                  function cleanup() { clearTimeout(timer); controller.signal.removeEventListener('abort', abort) }
                  controller.signal.addEventListener('abort', abort, { once: true })
                  if (controller.signal.aborted) abort()
                }).catch(() => {})
                if (controller.signal.aborted || imageDisposed) break
                try { settled = await deps.tavern.getTurn({ gameId, turn }) }
                catch { settled = null }
                if (settled) break
              }
              return settled || null
            })()
            settledTurnWaits.set(key, pending)
            wait = pending
            try { settled = await pending }
            finally {
              settledTurnWaitControllers.delete(controller)
              if (settledTurnWaits.get(key) === pending) settledTurnWaits.delete(key)
            }
          }
        }
        if (imageDisposed) return { attached: 0, error: '插件已卸载，停止等待正文' }
        if (!settled) return { attached: 0, error: '读不到这一轮（可能还没结算完，或轮次号不对）' }
        // 手动这条路也把「哪张卡」记下来（和自动那条共用一个缓存）
        rememberTurn(gameId, turn, settled.card)
        return deps.bridge.attachTurn({ gameId, turn, textVersion: settled.textVersion, text: settled.text, manual: !waited || config.plannerEnabled === false })
      },
    }
  })()
}

// =====================================================================
// 配置 / 工作流库 / 人物库
// =====================================================================

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`${path} 读取失败：${error.message}`)
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function cacheRoot(config) { return join(ROOT, String(config.cacheDir || DEFAULTS.cacheDir)) }

function imageMediaTypeFromBytes(bytes) {
  if (!bytes || bytes.length < 4) return ''
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return ''
}

/** 按配置生成 ComfyUI 的鉴权头。 */
function comfyHeaders(config) {
  const mode = String(config?.comfyAuthMode ?? 'none')
  if (mode === 'bearer' && config?.comfyAuthToken) return { authorization: 'Bearer ' + String(config.comfyAuthToken) }
  if (mode === 'basic' && config?.comfyAuthUser) {
    const raw = String(config.comfyAuthUser) + ':' + String(config.comfyAuthPass ?? '')
    return { authorization: 'Basic ' + Buffer.from(raw, 'utf8').toString('base64') }
  }
  return {}
}

const PRESET_SAMPLERS = new Set(['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'k_dpmpp_2m_sde', 'ddim_v3', 'k_lms', 'k_heun', 'k_dpm_2', 'k_dpm_2_ancestral'])
const PRESET_NOISE_SCHEDULES = new Set(['native', 'karras', 'exponential', 'polyexponential'])

/** 画风预设自带的生成参数：只保留认识的键并夹到合法范围；没写的键表示跟随渠道。 */
function normalizePresetParams(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  const number = (key, min, max, integer) => {
    const source = raw[key]
    if (source === undefined || source === null || source === '') return
    const value = Number(source)
    if (!Number.isFinite(value)) return
    out[key] = Math.max(min, Math.min(max, integer ? Math.round(value) : value))
  }
  number('steps', 1, 100, true)
  number('cfg', 0, 30)
  number('cfgRescale', 0, 1)
  number('uncondScale', 0, 10)
  number('skipCfgAboveSigma', 0, 1000)
  number('ucPreset', 0, 4, true)
  if (typeof raw.sampler === 'string' && PRESET_SAMPLERS.has(raw.sampler)) out.sampler = raw.sampler
  if (typeof raw.noiseSchedule === 'string' && PRESET_NOISE_SCHEDULES.has(raw.noiseSchedule)) out.noiseSchedule = raw.noiseSchedule
  if (typeof raw.qualityToggle === 'boolean') out.qualityToggle = raw.qualityToggle
  if (typeof raw.varietyBoost === 'boolean') out.varietyBoost = raw.varietyBoost
  return out
}

/** 当前选中的画风预设里存的生成参数（没选或没设就是空对象）。 */
function activePresetParams(config) {
  const id = String(config?.activePreset ?? config?.activeArtistSet ?? '')
  if (!id) return {}
  const presets = Array.isArray(config?.stylePresets) ? config.stylePresets : []
  const preset = presets.find(item => item && String(item.id) === id && item.enabled !== false)
  const params = preset?.params
  return params && typeof params === 'object' ? params : {}
}

/** 生图渠道 + 当前画风预设的参数覆盖；预设没写的键保持渠道原值。 */
function channelWithPresetParams(config) {
  const channel = activeChannel(config)
  if (!channel) return channel
  const params = activePresetParams(config)
  if (channel.provider !== 'novelai' || !Object.keys(params).length) return channel
  channel.options = { ...(channel.options ?? {}), ...params }
  return channel
}

/**
 * 取当前启用的画师串。多套里选一套（activeArtistSet 指向它），
 * 没选就用默认的 styleArtists；每套自己带 position（放最前 / 放最后）。
 */
function activeArtistText(config) {
  const fallback = { text: String(config?.styleArtists ?? ''), position: 'prefix', name: '默认', negative: String(config?.styleNegative ?? '') }
  const id = String(config?.activePreset ?? config?.activeArtistSet ?? '')
  if (!id) return fallback
  // 新版：画风预设
  const presets = Array.isArray(config?.stylePresets) ? config.stylePresets : []
  const p = presets.find(s => s && String(s.id) === id && s.enabled !== false)
  if (p && String(p.artist ?? '').trim()) {
    return { text: String(p.artist), position: p.position === 'suffix' ? 'suffix' : 'prefix', name: String(p.name ?? ''), negative: String(p.negative ?? '') }
  }
  // 兼容旧版：画师串多套
  const sets = Array.isArray(config?.artistSets) ? config.artistSets : []
  const hit = sets.find(s => s && String(s.id) === id && s.enabled !== false)
  if (hit && String(hit.text ?? '').trim()) {
    return { text: String(hit.text), position: hit.position === 'suffix' ? 'suffix' : 'prefix', name: String(hit.name ?? ''), negative: String(config?.styleNegative ?? '') }
  }
  return fallback
}

/** 扫描 workflows/ 目录，把配置里没有的文件补成条目（配置里的既有条目优先）。 */
async function scanWorkflows(config) {
  const configured = Array.isArray(config.workflows) ? config.workflows : []
  const byFile = new Map()
  for (const item of configured) if (item?.file) byFile.set(String(item.file).replace(/\\/g, '/'), item)
  const files = await readdir(WORKFLOW_DIR).catch(() => [])
  const merged = []
  for (const file of files.filter(item => item.toLowerCase().endsWith('.json')).sort()) {
    const rel = `workflows/${file}`
    const existing = byFile.get(rel) ?? byFile.get(file)
    merged.push(existing
      ? { ...existing, file: rel }
      : { id: file.replace(/\.json$/i, ''), label: file.replace(/\.json$/i, ''), file: rel, match: [], sizes: null })
  }
  for (const item of configured) {
    if (!item?.file) continue
    const rel = String(item.file).replace(/\\/g, '/')
    if (!merged.some(entry => entry.file === rel)) merged.push({ ...item, file: rel, missing: true })
  }
  return merged
}

/** 配置里像密钥的字符串（key/token/secret…），诊断日志写盘前会把它们替换掉。 */
function collectSecretValues(value, out = [], depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(key|token|secret|password|passwd|auth|bearer)/i.test(key) && item.length >= 6) out.push(item)
    else if (item && typeof item === 'object') collectSecretValues(item, out, depth + 1)
  }
  return out
}

async function loadConfig(overrides) {
  const file = await readJson(CONFIG_PATH, {})
  const config = { ...DEFAULTS, ...file, ...(overrides ?? {}) }
  config.comfyUrl = String(config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
  config.comfyMode = config.comfyMode === 'simple' ? 'simple' : 'workflow'
  config.comfySimple = normalizeComfySimpleConfig(config.comfySimple)
  config.promptPresets = normalizePromptPresets(config.promptPresets)
  if (!['auto', 'tags', 'natural', 'mixed'].includes(config.promptMode)) config.promptMode = 'auto'
  config.activePromptPreset = validPromptPresetId(config, String(config.activePromptPreset ?? '').slice(0, 80))
  config.promptManualPositive = String(config.promptManualPositive ?? '').slice(0, 4000)
  config.promptManualNegative = String(config.promptManualNegative ?? '').slice(0, 4000)
  config.jpegOutput = config.jpegOutput === true
  config.jpegQuality = Math.max(50, Math.min(100, Math.round(Number(config.jpegQuality) || 88)))
  config.jpegBackground = /^#?[0-9a-f]{6}$/i.test(String(config.jpegBackground ?? '')) ? ('#' + String(config.jpegBackground).replace(/^#/, '')) : '#ffffff'
  config.injectWeight = Number(config.injectWeight) || 0
  config.imageGenCount = Math.max(1, Math.min(6, Number(config.imageGenCount) || 2))
  config.imageChannels = normalizeChannels(config.imageChannels)
  config.imageConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(config.imageConcurrency)) || 2))
  config.imageDisplayWidth = normalizeImageDisplayWidth(config.imageDisplayWidth)
  config.credentialRefs = Array.isArray(config.credentialRefs) ? config.credentialRefs.filter(item => typeof item === 'string') : []
  await credentialStore.load(config)
  return config
}

async function saveConfig(config) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = config[key]
  out.workflows = (config.workflows ?? []).map(item => {
    const copy = { ...item }
    delete copy.discovered
    delete copy.error
    delete copy.summary
    return copy
  })
  const write = configWriteQueue.catch(() => {}).then(async () => {
    await credentialStore.persist(config, out)
    await writeJsonAtomic(CONFIG_PATH, out)
  })
  configWriteQueue = write.catch(() => {})
  await write
}

function normalizeCharacter(raw, index) {
  const item = {
    id: String(raw?.id ?? `characters-${index + 1}`),
    enabled: raw?.enabled !== false,
    name: String(raw?.name ?? ''),
    match: Array.isArray(raw?.match) ? raw.match.join(', ') : String(raw?.match ?? ''),
    // 形态线索：同一角色的这个形态在画面里的标志（如 fox ears, fox tail, 狐耳），用来自动选形态。
    formCues: Array.isArray(raw?.formCues) ? raw.formCues.join(', ') : String(raw?.formCues ?? ''),
    continuity: String(raw?.continuity ?? ''),
    note: String(raw?.note ?? ''),
    // 分组：只用于人物库列表的分组排序和搜索，不参与关键词触发、宏解析或提示词。
    group: String(raw?.group ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40),
    inject: raw?.inject && typeof raw.inject === 'object' ? { ...raw.inject } : {},
    // 绑定到哪些卡（空 = 所有卡都能用）；可复用的通用服装 id
    cards: Array.isArray(raw?.cards) ? raw.cards.map(String) : splitTags(raw?.cards),
    outfitRefs: Array.isArray(raw?.outfitRefs) ? raw.outfitRefs.map(String) : splitTags(raw?.outfitRefs),
  }
  const traits = raw?.traits && typeof raw.traits === 'object' ? { ...raw.traits } : {}
  // 兼容最老的单字段写法
  if (!traits.face && raw?.appearance) traits.face = String(raw.appearance)
  for (const [oldKey, newKey] of Object.entries(LEGACY_TRAITS)) {
    if (traits[oldKey] && !traits[newKey]) traits[newKey] = traits[oldKey]
  }
  item.traits = {}
  for (const [key] of CHARACTER_TRAITS) item.traits[key] = String(traits[key] ?? '')
  const outfits = Array.isArray(raw?.outfits) ? raw.outfits.slice() : []
  if (!outfits.length && raw?.outfit) outfits.push({ id: 'o1', name: '常服', body: String(raw.outfit), default: true })
  item.outfits = outfits.map((outfit, j) => ({
    id: String(outfit?.id ?? `outfit-${index + 1}-${j + 1}`),
    name: String(outfit?.name ?? `服装 ${j + 1}`),
    upper: String(outfit?.upper ?? outfit?.body ?? ''),
    lower: String(outfit?.lower ?? ''),
    shoes: String(outfit?.shoes ?? ''),
    accessory: String(outfit?.accessory ?? outfit?.bodyBack ?? ''),
    full: String(outfit?.full ?? ''),
    back: String(outfit?.back ?? outfit?.fullBack ?? ''),
    negative: String(outfit?.negative ?? ''),
    enabled: outfit?.enabled !== false,
    default: outfit?.default === true,
  }))
  return item
}

function normalizeDefinition(kind, raw, index) {
  if (kind === 'characters') return normalizeCharacter(raw, index)
  const item = { id: String(raw?.id ?? `${kind}-${index + 1}`), enabled: raw?.enabled !== false }
  for (const field of DEFINITION_KINDS[kind].fields) {
    const value = raw?.[field]
    item[field] = typeof value === 'string' ? value : (Array.isArray(value) ? value.join(', ') : '')
  }
  item.inject = raw?.inject && typeof raw.inject === 'object' ? { ...raw.inject } : {}
  return item
}

async function loadDefinitions() {
  const raw = await readJson(DEFS_PATH, null)
  const source = raw ?? {}
  return {
    version: 3,
    characters: (source.characters ?? []).map((item, i) => normalizeDefinition('characters', item, i)),
    settings: (source.settings ?? []).map((item, i) => normalizeDefinition('settings', item, i)),
    props: (source.props ?? []).map((item, i) => normalizeDefinition('props', item, i)),
    outfits: (source.outfits ?? []).map((item, i) => normalizeOutfit(item, i)),
  }
}

/** 保存前先备份：万一某次保存把角色写少了，还能从 backups/ 捞回来。 */
async function backupDefinitions() {
  try {
    const current = await readJson(DEFS_PATH, null)
    if (!current || !Array.isArray(current.characters) || !current.characters.length) return
    const dir = join(ROOT, 'backups')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await writeJsonAtomic(join(dir, 'definitions-' + stamp + '.json'), current)
    const files = (await readdir(dir).catch(() => [])).filter(n => /^definitions-/.test(n)).sort()
    for (const old of files.slice(0, Math.max(0, files.length - 12))) {
      await rm(join(dir, old), { force: true }).catch(() => {})
    }
  } catch { /* 备份失败不能挡住保存 */ }
}

/** 完全空的角色（没名字、没外貌、没任何字段）不能入库 —— 曾经因为解析失败写进过两个空白条目。 */
function isEmptyCharacter(character) {
  if (!character || typeof character !== 'object') return true
  if (String(character.name ?? '').trim()) return false
  if (String(character.traits?.face ?? '').trim()) return false
  return !Object.values(character.traits ?? {}).some(v => String(v ?? '').trim())
}


// =====================================================================
// 世界书：导入 / 导出 / 条目开关
// =====================================================================

/** 保留条目开关、正文与按需注入条件；旧条目默认常驻。 */
function normalizeWorldbook(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const chunks = raw.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    return { name: '导入的世界书', entries: chunks.map((c, i) => ({ comment: '条目 ' + (i + 1), content: c, enabled: true, ...normalizeEntryActivation({}) })) }
  }
  if (!raw || typeof raw !== 'object') return null
  // ① 已经是本插件格式
  if (Array.isArray(raw.entries)) {
    return {
      name: String(raw.name ?? '生图世界书'),
      entries: raw.entries.map((e, i) => ({
        comment: String(e?.comment ?? e?.name ?? ('条目 ' + (i + 1))),
        content: String(e?.content ?? ''),
        enabled: e?.enabled !== false && e?.disable !== true,
        ...normalizeEntryActivation(e),
      })),
    }
  }
  // ② SillyTavern 世界书：{ entries: { "0": {...}, ... } } 或 { "名字": { entries: [...] } }
  const inner = typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    ? raw.entries
    : (Object.values(raw)[0] && typeof Object.values(raw)[0] === 'object' && (Object.values(raw)[0].entries)
        ? Object.values(raw)[0].entries
        : null)
  if (inner) {
    const list = Array.isArray(inner) ? inner : Object.values(inner)
    const entries = list
      .filter(e => e && typeof e === 'object')
      .map((e, i) => ({
        comment: String(e.comment ?? e.name ?? ('条目 ' + (i + 1))),
        content: String(e.content ?? ''),
        enabled: e.enabled !== false && e.disable !== true,
        ...normalizeEntryActivation(e),
      }))
      .filter(e => e.content.trim())
    if (entries.length) return { name: String(raw.name ?? Object.keys(raw)[0] ?? '导入的世界书'), entries }
  }
  // ③ 纯数组
  if (Array.isArray(raw)) {
    const entries = raw
      .filter(e => e && typeof e === 'object')
      .map((e, i) => ({ comment: String(e.comment ?? e.name ?? ('条目 ' + (i + 1))), content: String(e.content ?? ''), enabled: e.enabled !== false && e.disable !== true, ...normalizeEntryActivation(e) }))
      .filter(e => e.content.trim())
    if (entries.length) return { name: '导入的世界书', entries }
  }
  return null
}

/**
 * 原子写 + 重试。Windows 上两个写入同时 rename 同一个目标会抛 EPERM，
 * 重试几次就过去了（那个抢占的写入通常几毫秒就结束）。
 */
/**
 * 直接覆盖写（不经过 rename）。
 *
 * 这个目录里 rename 覆盖已存在的文件会被系统拒绝（EPERM: operation not permitted），
 * 所以这里放弃"原子替换"，改成「先把旧内容存一份备份 → 直接写目标文件」。
 * 对世界书这种几 MB 以内的文件足够安全。
 */
/** 尺寸写成 "宽x高"；既接受 { width, height } 也接受已经格式化好的文字，缺值时返回空串。 */
function sizeLabel(size) {
  if (typeof size === 'string') return /^\d+x\d+$/.test(size) ? size : ''
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) ? size.width + 'x' + size.height : ''
}

const SAFE_WRITE_BACKUPS = 12

async function writeJsonSafe(path, value, backupDir) {
  const text = JSON.stringify(value, null, 2)
  // 先备份旧的（失败不影响写入）
  try {
    const old = await readFile(path, 'utf8')
    if (old && backupDir) {
      await mkdir(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const base = path.split(/[\\/]/).pop().replace(/\.json$/, '')
      await writeFile(join(backupDir, base + '-' + stamp + '.json'), old, 'utf8')
      // 只留最近 SAFE_WRITE_BACKUPS 份自动备份（只认这里生成的「名字-时间戳.json」，手动备份和文件夹不动）。
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const own = new RegExp('^' + escaped + '-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.json$')
      const mine = (await readdir(backupDir).catch(() => [])).filter(name => own.test(name)).sort()
      for (const stale of mine.slice(0, Math.max(0, mine.length - SAFE_WRITE_BACKUPS))) await rm(join(backupDir, stale), { force: true }).catch(() => {})
    }
  } catch { /* 没有旧文件就没得备份 */ }

  let lastError = null
  for (let i = 0; i < 6; i++) {
    try {
      // 目标可能是只读的（打包时带的 0444 权限）——直接写会被系统拒绝（EPERM），先去掉只读
      await chmod(path, 0o644).catch(() => {})
      await writeFile(path, text, 'utf8')
      return true
    } catch (error) {
      lastError = error
      // 还是不行就删掉重写（目录本身是可写的，删得掉）
      if (i === 3) {
        try {
          const { rm } = await import('node:fs/promises')
          await rm(path, { force: true })
        } catch {}
      }
      await new Promise(r => setTimeout(r, 50 * (i + 1)))
    }
  }
  throw lastError ?? new Error('写入失败')
}

async function writeJsonRetry(path, value, tries = 6) {
  let lastError = null
  for (let i = 0; i < tries; i++) {
    try {
      await writeJsonAtomic(path, value)
      return true
    } catch (error) {
      lastError = error
      await new Promise(r => setTimeout(r, 40 * (i + 1)))
    }
  }
  throw lastError ?? new Error('写入失败')
}

async function saveDefinitions(definitions) {
  // ═══ 防清空闸门（2026-10-07）═══
  // 事故：有脚本带着空 body 调用 definitions 接口，把用户 5 个角色 + 4 套服装
  //       一次性覆盖成空。这里是最底层的写入口，所有路径都经过它，所以闸门放这。
  try {
    const before = await readJson(DEFS_PATH, null)
    const beforeChars = Array.isArray(before?.characters) ? before.characters.length : 0
    const nextChars = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (beforeChars > 0 && nextChars === 0) {
      throw new Error('refused: would empty ' + beforeChars + ' characters')
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('refused:')) {
      // 记一笔到 backups（模块级没有 logger）
      try {
        const dir = join(ROOT, 'backups')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'refused-empty-' + Date.now() + '.txt'),
          '已拒绝清空角色库：' + String(error.message) + '\n')
      } catch {}
      return false
    }
    // 读磁盘失败不该阻断正常保存
  }
  // 双保险：前端万一漏了，这里再挡一次
  if (Array.isArray(definitions?.characters)) {
    const kept = definitions.characters.filter(ch => !isEmptyCharacter(ch))
    if (kept.length !== definitions.characters.length) {
      /* 拦下空角色（模块级没日志器，静默处理） */
      definitions = Object.assign({}, definitions, { characters: kept })
    }
  }
  // 这里不能打日志：saveDefinitions 是模块级函数，logger / addClientReport 在 runtime 闭包里
  try {
    const before = await readJson(DEFS_PATH, null)
    // 只在"角色数变少"时留痕（那是需要事后追查的情况），且走文件而不是 logger
    const wasCount = Array.isArray(before?.characters) ? before.characters.length : 0
    const nowCount = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (wasCount > nowCount) {
      const dir = join(ROOT, 'backups')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'characters-dropped-' + Date.now() + '.txt'),
        '角色数从 ' + wasCount + ' 减到 ' + nowCount + '\n' +
        '原来：' + (before.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n' +
        '现在：' + (definitions.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n', 'utf8')
    }
  } catch {}
  // 角色数变少时先备份并记一笔，方便事后追查
  try {
    const before = await readJson(DEFS_PATH, null)
    const wasCount = Array.isArray(before?.characters) ? before.characters.length : 0
    const nowCount = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (nowCount) {
      await backupDefinitions()
      if (wasCount > nowCount) {
        try {
          const dir = join(ROOT, 'backups')
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'characters-dropped-' + Date.now() + '.txt'),
            '角色数从 ' + wasCount + ' 减到 ' + nowCount + '\n' +
            '原来：' + (before.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n' +
            '现在：' + (definitions.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n', 'utf8')
        } catch {}
      }
    }
  } catch {}
  await writeJsonSafe(DEFS_PATH, {
    version: 3,
    characters: definitions.characters ?? [],
    settings: definitions.settings ?? [],
    props: definitions.props ?? [],
    outfits: definitions.outfits ?? [],
  }, join(ROOT, 'backups'))
}

/** 从工作流里读几个"人看得懂"的事实：用了哪个底模、挂了哪些 LoRA、多少节点。 */

// =====================================================================
// 工作流：导入（ComfyUI API JSON）与节点自动识别
// =====================================================================

/**
 * 从 ComfyUI 的 API 格式 JSON 里认出一张工作流的"可调参数"。
 * 正/负面靠"谁连到采样器的 positive / negative 输入"判断，这是唯一可靠的办法。
 */
function detectWorkflow(nodes) {
  const bind = { positive: [], negative: [], seed: [], batch: [], size: [], steps: [], cfg: [], model: [], loras: [], sampler: [] }
  const list = Object.entries(nodes ?? {}).map(([id, node]) => ({ id, node }))
  const byType = (t) => list.filter(x => x.node?.class_type === t)

  // 这个节点里「可以写提示词的那个输入」：值必须是字面量字符串（连线的值是数组，别碰）。
  // 各家的文本节点叫法不一样：CLIPTextEncode 的 text、String Literal 的 string、还有
  // Text (Multiline)、PrimitiveNode、CR Text 之类，所以先按常见输入名猜，再退而求其次。
  const textInputsOf = (node) => {
    const inp = node?.inputs ?? {}
    const type = String(node?.class_type ?? '')
    const title = String(node?._meta?.title ?? '')
    // Text composition nodes often contain a literal delimiter alongside links. Never
    // bind the delimiter; follow the second (content) branch to the editable prompt.
    if (/StringConcatenate/i.test(type)) return Object.hasOwn(inp, 'string_b') ? ['string_b'] : []
    // 只有节点类型或标题明确表示文本节点时才认它，避免把模型名、路径、模式等
    // 任意字符串输入误判成可编辑提示词。
    const recognizedType = /(?:text|prompt|primitive|stringliteral|multiline)/i.test(type)
    const recognizedTitle = /(?:text|prompt|提示词|正向|负面|反向)/i.test(title)
    if (!recognizedType && !recognizedTitle) return []
    const preferred = ['text', 'text_g', 'text_l', 'string', 'string_a', 'string_b', 'prompt', 'content', 'value', 'positive', 'negative']
    const found = preferred.filter(key => typeof inp[key] === 'string' || Array.isArray(inp[key]))
    if (found.length) return found
    // 自定义文本节点可能用其他字段名；仅允许文本类节点回退，并排除明显的非文本字段。
    for (const [key, value] of Object.entries(inp)) {
      if (typeof value !== 'string') continue
      if (/name|path|file|url|id|seed|sampler|scheduler|model|ckpt|vae|clip|lora|dtype|device|precision/i.test(key)) continue
      found.push(key)
      break
    }
    return found
  }

  // 顺着连线往回找「真正写字的那一格」。
  // 有些工作流的编码节点本身不写文本，文本来自上游节点，例如：
  //   KSampler → 正向编码（无额外质量词）→ 全局主体提示词（ComfyUI 核心多行文本）
  // 此时可直接写的目标是 Text (Multiline)，而不是中间那个 CLIPTextEncode。
  // 只认字面量字符串，最多回溯 8 跳，带环保护。
  const resolveTextTargets = (startId) => {
    const seen = new Set()
    const queue = [{ id: String(startId ?? ''), hop: 0 }]
    const targets = []
    while (queue.length) {
      const { id, hop } = queue.shift()
      if (!id || !nodes[id] || seen.has(id) || hop > 8) continue
      seen.add(id)
      // A zeroed conditioning node explicitly means no negative prompt text.
      if (/ConditioningZeroOut/i.test(String(nodes[id]?.class_type ?? ''))) continue
      const inp = nodes[id].inputs ?? {}
      const keys = textInputsOf(nodes[id])
      let foundLiteral = false
      for (const key of keys) {
        const value = inp[key]
        if (typeof value === 'string') {
          targets.push({ node: id, input: key })
          foundLiteral = true
        } else if (Array.isArray(value) && value.length >= 2) {
          const target = String(value[0])
          if (nodes[target]) queue.push({ id: target, hop: hop + 1 })
        }
      }
      if (!keys.length && hop < 8) {
        for (const key of ['conditioning', 'positive', 'negative']) {
          const value = inp[key]
          if (Array.isArray(value) && value.length >= 2 && nodes[String(value[0])]) queue.push({ id: String(value[0]), hop: hop + 1 })
        }
      }
    }
    return targets
  }

  // 采样器（各种 KSampler 变体）
  const samplerLinked = { positive: false, negative: false }
  const samplers = list.filter(x => /^KSampler/i.test(String(x.node?.class_type ?? '')))
  for (const { id, node } of samplers) {
    const inp = node.inputs ?? {}
    // 正/负面：采样器的 positive / negative 指到的节点；若那个节点只是中转（它的文本来自
    // 上游的 Text (Multiline) 之类），就继续往回找，写进真正能接受文本的那一格。
    for (const [role, key] of [['positive', 'positive'], ['negative', 'negative']]) {
      const link = inp[key]
      const srcId = Array.isArray(link) ? String(link[0]) : (typeof link === 'string' ? link : '')
      if (srcId && nodes[srcId]) samplerLinked[role] = true
      const targets = srcId && nodes[srcId] ? resolveTextTargets(srcId) : []
      bind[role].push(...targets)
    }
    if (typeof inp.noise_seed === 'number' || 'noise_seed' in inp) bind.seed.push({ node: id, input: 'noise_seed' })
    if (typeof inp.seed === 'number' || 'seed' in inp) bind.seed.push({ node: id, input: 'seed' })
    if ('steps' in inp) bind.steps.push({ node: id, input: 'steps' })
    if ('cfg' in inp) bind.cfg.push({ node: id, input: 'cfg' })
    if ('sampler_name' in inp || 'scheduler' in inp) bind.sampler.push({ node: id })
  }

  // 正/负面兜底：完全没有连线可循时，把整张图里的「文字格」找出来再分角色。
  // 先按节点标题判（"正向/正面/positive" vs "负面/反向/negative"），剩下的按
  // CLIPTextEncode 优先、再按出现顺序取前两个。这样 Text (Multiline)、String Literal
  // 这类非 CLIPTextEncode 的文本节点也能被认出来（见 issue：提示词位置无法选择）。
  if (!bind.positive.length || !bind.negative.length) {
    const taken = new Set([...bind.positive, ...bind.negative].map(x => String(x.node)))
    const slots = []
    for (const { id, node } of list) {
      if (taken.has(String(id))) continue
      const inputs = textInputsOf(node).filter(key => typeof node.inputs?.[key] === 'string')
      if (!inputs.length) continue
      const title = String(node?._meta?.title ?? '')
      const type = String(node?.class_type ?? '')
      for (const input of inputs) slots.push({
        id, input, type, rank: /CLIPTextEncode|TextEncode/i.test(type) ? 0 : 1,
        role: /负面|反向|negative/i.test(title) ? 'negative' : (/正向|正面|positive/i.test(title) ? 'positive' : ''),
      })
    }
    const titledNode = { positive: '', negative: '' }
    const needRole = {
      positive: !bind.positive.length && !samplerLinked.positive,
      negative: !bind.negative.length && !samplerLinked.negative,
    }
    for (const slot of slots) {
      const role = slot.role
      if (!role || !needRole[role]) continue
      if (!titledNode[role]) titledNode[role] = String(slot.id)
      if (titledNode[role] === String(slot.id)) bind[role].push({ node: slot.id, input: slot.input })
    }
    const groups = new Map()
    for (const slot of slots) {
      if (bind.positive.some(b => String(b.node) === String(slot.id)) || bind.negative.some(b => String(b.node) === String(slot.id))) continue
      const key = String(slot.id)
      if (!groups.has(key)) groups.set(key, { id: slot.id, rank: slot.rank, slots: [] })
      groups.get(key).slots.push(slot)
    }
    const rest = [...groups.values()].sort((a, b) => a.rank - b.rank)
    if (needRole.positive && !bind.positive.length && rest.length) bind.positive.push(...rest.shift().slots.map(({ id, input }) => ({ node: id, input })))
    if (needRole.negative && !bind.negative.length && rest.length) bind.negative.push(...rest[0].slots.map(({ id, input }) => ({ node: id, input })))
  }

  // 尺寸：EmptyLatentImage / 任何带 width+height 的节点
  const sizeNode = list.find(x => typeof x.node?.inputs?.width === 'number' && typeof x.node?.inputs?.height === 'number')
  if (sizeNode) bind.size.push({ node: sizeNode.id, input: 'width' })

  // batch
  const batchNode = list.find(x => 'batch_size' in (x.node?.inputs ?? {}))
  if (batchNode) bind.batch.push({ node: batchNode.id, input: 'batch_size' })

  // 底模
  for (const { id, node } of list) {
    const t = String(node?.class_type ?? '')
    const inp = node?.inputs ?? {}
    if (/CheckpointLoaderSimple|CheckpointLoader/i.test(t) && typeof inp.ckpt_name === 'string') bind.model.push({ node: id, input: 'ckpt_name' })
    else if (/UNETLoader/i.test(t) && typeof inp.unet_name === 'string') bind.model.push({ node: id, input: 'unet_name' })
    else if (/AnimaBoosterLoader/i.test(t) && typeof inp.model_name === 'string') bind.model.push({ node: id, input: 'model_name' })
  }

  // LoRA：每一个 LoraLoader 都列出来（用户可以在界面上改权重 / 停用）
  for (const { id, node } of byType('LoraLoader')) {
    const inp = node.inputs ?? {}
    bind.loras.push({
      node: id,
      input: 'lora_name',
      name: String(inp.lora_name ?? ''),
      strengthModel: Number(inp.strength_model ?? 1),
      strengthClip: Number(inp.strength_clip ?? inp.strength_model ?? 1),
      enabled: true,
    })
  }

  // 一张图里常有两个采样器（主采样 + 高清修复二次采样），它们各报一遍正负面，
  // 同一个目标就会被登记两次；去重，免得界面上出现两行一模一样的绑定。
  for (const key of Object.keys(bind)) {
    const seen = new Set()
    bind[key] = bind[key].filter((item) => {
      const sig = String(item?.node ?? '') + '|' + String(item?.input ?? '')
      if (seen.has(sig)) return false
      seen.add(sig)
      return true
    })
  }

  // 输出节点：SaveImage / PreviewImage 优先
  const out = list.find(x => /SaveImage|PreviewImage/i.test(String(x.node?.class_type ?? '')))
  return { bindings: bind, outputNode: out ? out.id : '' }
}

/** 把外部 JSON 规范成插件的工作流格式。接受 ComfyUI API JSON、已带 bindings 的、或裸节点表。 */
export function normalizeWorkflow(raw, fallbackName) {
  if (!raw || typeof raw !== 'object') return null
  // 已经是插件的格式
  if (raw.bindings && raw.prompt) {
    return {
      format: 'dsh-tavern-image-v1',
      name: String(raw.name ?? fallbackName ?? '导入的工作流'),
      prompt: raw.prompt,
      outputNode: String(raw.outputNode ?? ''),
      bindings: raw.bindings,
      digest: String(raw.digest ?? ''),
    }
  }
  // ComfyUI API JSON：{ "3": {...}, "4": {...} } 或 { prompt: {...} }
  const nodes = raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : (raw.workflow && typeof raw.workflow === 'object' ? raw.workflow : raw)
  const realNodes = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue
    if (typeof node.class_type !== 'string') continue
    realNodes[id] = node
  }
  if (!Object.keys(realNodes).length) return null
  const { bindings, outputNode } = detectWorkflow(realNodes)
  return {
    format: 'dsh-tavern-image-v1',
    name: String(raw.name ?? fallbackName ?? '导入的工作流'),
    prompt: realNodes,
    outputNode,
    bindings,
    digest: '',
  }
}

function workflowSummary(raw) {
  const nodes = Object.values(raw?.prompt ?? {})
  const pick = (types, keys) => {
    for (const node of nodes) {
      if (!types.includes(node.class_type)) continue
      for (const key of keys) if (typeof node.inputs?.[key] === 'string') return node.inputs[key]
    }
    return ''
  }
  const sizeNode = nodes.find(node => typeof node.inputs?.width === 'number' && typeof node.inputs?.height === 'number')
  // 正负面的摘要：卡片上直接显示，一眼能看出这张给模型灌了什么
  const peek = (arr) => {
    const it = Array.isArray(arr) ? arr[0] : null
    if (!it) return ''
    const text = nodes.find(n => String(n.__id) === String(it.node))?.inputs?.[it.input || 'text']
    const raw = (raw0 && raw0.prompt && raw0.prompt[it.node] && raw0.prompt[it.node].inputs && raw0.prompt[it.node].inputs[it.input || 'text'])
    const v = raw ?? text ?? ''
    return String(v).replace(/\s+/g, ' ').slice(0, 60)
  }
  const raw0 = raw
  const positivePeek = peek(raw0?.bindings?.positive)
  const negativePeek = peek(raw0?.bindings?.negative)
  return {
    positivePeek,
    negativePeek,
    model: pick(['UNETLoader', 'CheckpointLoaderSimple', 'AnimaBoosterLoader'], ['unet_name', 'ckpt_name', 'model_name']),
    clip: pick(['CLIPLoader', 'DualCLIPLoader'], ['clip_name', 'clip_name1']),
    loras: nodes.filter(node => node.class_type === 'LoraLoader').map(node => node.inputs?.lora_name).filter(Boolean),
    base: sizeNode ? `${sizeNode.inputs.width}x${sizeNode.inputs.height}` : '',
    nodeCount: nodes.length,
  }
}

// =====================================================================
// 提示词处理
// =====================================================================

/** NovelAI 的 {}/[]/n::tag:: 权重语法 → SD 的 (tag:n)。 */
export function convertWeights(text) {
  let out = String(text ?? '')
  out = out.replace(/(-?\d+(?:\.\d+)?)::([^:]+)::/g, (_m, weight, tag) => {
    const value = Number(weight)
    if (!Number.isFinite(value)) return tag.trim()
    if (value <= 0) return `(${tag.trim()}:0.5)`
    return `(${tag.trim()}:${String(Math.min(2, Math.max(0.5, value))).slice(0, 5)})`
  })
  out = out.replace(/(\{+)([^{}]+)(\}+)/g, (_m, open, body, close) => {
    const depth = Math.min(4, Math.min(open.length, close.length))
    return `(${body.trim()}:${[0, 1.05, 1.1, 1.15, 1.2][depth]})`
  })
  // 方括号只剥括号保留内容：NAI 的 [[[artist:x]]] 在 SD 系里不该被当成降权
  out = out.replace(/(\[+)([^[\]]+)(\]+)/g, (_m, _open, body) => body.trim())
  return tidyTags(out)
}

export function stripWeights(text) {
  return tidyTags(String(text ?? '')
    .replace(/-?\d+(?:\.\d+)?::([^:]+)::/g, '$1')
    .replace(/[{}[\]]/g, ''))
}

function tidyTags(text) {
  return String(text).split(',').map(part => part.trim()).filter(Boolean).join(', ')
}

function splitTags(text) {
  return String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)
}

/** 拆出"已经出现过的 tag"集合，用于避免重复注入。 */
function tagSet(text) {
  const set = new Set()
  const lower = String(text).toLowerCase().replace(/:\s*[\d.]+\s*(?=[,)]|$)/g, '')
  for (const part of lower.split(',')) {
    const tag = part.trim().replace(/^[([]+/, '').replace(/[)\]]+$/, '').trim()
    if (!tag) continue
    set.add(tag)
    const colon = tag.indexOf(':')
    if (colon >= 0) {
      const tail = tag.slice(colon + 1).trim()
      if (tail) set.add(tail)
    }
  }
  return set
}

function applyWeights(text, mode) {
  if (mode === 'keep') return String(text ?? '')
  return mode === 'strip' ? stripWeights(text) : convertWeights(text)
}

/** 人物库注入：提示词里出现某个定义的名字（或触发词）时，把它的稳定 tag 补齐。 */
/**
 * 名字是否作为**完整词**出现在正文里。
 * PR #14 修好了人物宏的精确匹配，但这里仍用 source.includes(key)：短别名会命中更长的名字
 * （Li 命中 Lina），于是把外貌/服装注入给错的人。
 * 规则：中文按子串（中文没有词边界），拉丁词加边界，避免短名吃掉长名。
 */
function containsNameToken(text, key) {
  const needle = String(key || '').trim()
  if (!needle) return false
  const source = String(text || '')
  if (!source) return false
  // 中文没有词边界，按子串判断即可
  for (const ch of needle) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fa5) return source.includes(needle)
  }
  // 拉丁词：前后不能紧邻字母、数字或下划线（否则 Li 会命中 Lina）
  const boundaryChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
  const haystack = source.toLowerCase()
  const needleLower = needle.toLowerCase()
  let from = haystack.indexOf(needleLower)
  while (from >= 0) {
    const beforeOk = from === 0 || boundaryChars.indexOf(source[from - 1]) < 0
    const afterAt = from + needle.length
    const afterOk = afterAt >= source.length || boundaryChars.indexOf(source[afterAt]) < 0
    if (beforeOk && afterOk) return true
    from = haystack.indexOf(needleLower, from + 1)
  }
  return false
}
export function injectDefinitions(text, definitions, config = {}, options = {}) {
  const source = String(text ?? '')
  if (!source || !definitions) return { text: source, hits: [] }
  const have = tagSet(source)
  const added = []
  const hits = []
  const negatives = []
  const weight = Number(config.injectWeight) || 0
  const nsfw = NSFW_HINT.test(source)
  const back = BACK_VIEW.test(source)
  const full = FULL_FRAME.test(source)
  const natural = options?.style === 'natural'
  // 规划原文（options.raw，带宏）去掉宏后判断是不是裸露画面。没有原文时只看 nsfw：
  // 这里的文字已经展开了人物外貌，外貌里的 medium breasts 之类会让每张图都被当成裸露画面。
  const bareScene = Boolean(options?.raw) && BARE_SCENE.test(stripMacros(options.raw))
  const footText = stripMacros(options?.raw ?? source)
  const barefoot = BAREFOOT.test(footText)
  // 规划里的人物宏已经展开过的人，不再按名字重复注入；他的其他形态也不注入
  // （否则同一个人的两种外貌会同时出现）。
  const label = c => (splitTags(c?.match)[0] || String(c?.name ?? '')) + ' is '
  const fingerprint = c => [c?.traits?.face, c?.traits?.faceBack].map(v => String(v ?? '').trim()).filter(v => v.length >= 12)
  const expanded = (definitions.characters ?? []).filter(c => c && c.enabled !== false && (
    ['the woman', 'the man', 'a character'].some(who => source.includes(label(c) + who + ' in this scene')) ||
    fingerprint(c).some(f => source.includes(f))))
  // 人物的负面词作用于整张图：多人画面里 A 的「不要短发」会压掉 B 的短发。
  // 所以先按人收集，最后只在画面里只有一个库中人物时才用上。
  const personNegatives = []
  for (const character of definitions.characters ?? []) {
    if (!character || character.enabled === false) continue
    if (expanded.includes(character)) {
      hits.push(character.name || character.id)
      // 人物宏展开时负面词没地方放（宏只产出正向文字），在这里补回负向通道。
      const own = String(character.traits?.negative ?? '').trim()
      personNegatives.push(own && !PLACEHOLDER_VALUE.test(own) ? [own] : [])
      continue
    }
    if (expanded.some(other => sameCharacterFamily(character, other))) continue
    const keys = splitTags(character.match).length ? splitTags(character.match) : [character.name].filter(Boolean)
    if (!keys.some(key => containsNameToken(source, key))) continue
    hits.push(character.name || character.id)
    // 露的画面（nsfw 或写着洗澡/裸体/内衣）不自动补衣服：既不补「当前穿着」，也不补常穿。
    const bare = nsfw || bareScene || NOTHING_WORN.test(String(character.current?.outfit ?? '').trim())
    const recordedRaw = bare ? '' : resolveWearText(character, character.current?.outfit)
    const recorded = barefoot ? dropFootwear(recordedRaw) : recordedRaw
    const picked = characterTags(character, { nsfw, back, full, mode: config.traitMode, barefoot, noOutfit: Boolean(recordedRaw) || bare })
    // options.provenance：诊断用，记录每段注入文字来自哪个人物的哪个字段、作用于正向还是整图负向。
    if (Array.isArray(options?.provenance)) for (const origin of picked.origins ?? []) options.provenance.push({ stage: 'definition-injection', characterId: String(character.id ?? ''), characterName: String(character.name ?? ''), matchedBy: keys.find(key => key && source.includes(key)) ?? '', appliedScope: origin.channel === 'negative' ? 'whole-image-negative' : 'whole-image-positive', ...origin })
    if (natural) {
      const phrase = boundCharacterPhrase(character, picked, [], recorded)
      if (phrase && !source.includes(phrase)) added.push(phrase)
    } else for (const raw of [...picked.tags, recorded].filter(Boolean)) {
      // tag 写法里「当前穿着」也要写进去（以前只有自然语言写法带上它，tag 写法里这个人就没衣服了）。
      for (const tag of splitTags(raw)) {
        const key = tag.toLowerCase()
        if (!key || have.has(key)) continue
        have.add(key)
        added.push(weight > 0 && weight !== 1 ? `(${tag}:${weight})` : tag)
      }
    }
    // 人物的负面词（例如"不要画成小孩"）走负向通道，绝不进正向提示词
    personNegatives.push(picked.negative ?? [])
  }
  // 规划原文里调用了几个不同的库中人物（同一角色的不同形态算一个）。tag 写法下展开后的文字认不出人，所以看原文。
  const rawText = String(options?.raw ?? '')
  const calledNames = [...rawText.matchAll(/\$\{([\s\S]*?)\}\$/g)].map(m => { try { return String(JSON.parse('{' + m[1] + '}').name ?? '').trim().toLowerCase() } catch { return '' } }).filter(Boolean)
  const called = (definitions.characters ?? []).filter(c => c && c.enabled !== false && [c.id, c.name, ...splitTags(c.match)].some(k => k && calledNames.includes(String(k).trim().toLowerCase())))
  const families = called.filter((c, i) => !called.slice(0, i).some(o => sameCharacterFamily(c, o)))
  // 画面里写着的东西不能出现在负面里（例如路人的 short black hair 对上负面的 short hair）。
  const chunks = source.toLowerCase().split(/[,\n]/).map(t => t.trim()).filter(Boolean)
  const shown = tag => { const words = tag.toLowerCase().split(/\s+/).filter(Boolean); return words.length > 0 && chunks.some(chunk => words.every(w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(chunk))) }
  if (personNegatives.length === 1 && families.length <= 1) {
    for (const raw of personNegatives[0]) {
      for (const tag of splitTags(raw)) {
        const key = tag.toLowerCase()
        if (!key || negatives.includes(tag) || shown(tag)) continue
        negatives.push(tag)
      }
    }
  }
  for (const kind of ['settings', 'props']) {
    for (const def of definitions[kind] ?? []) {
      if (!def || def.enabled === false) continue
      const keys = splitTags(def.match).length ? splitTags(def.match) : [def.name].filter(Boolean)
      if (!keys.some(key => containsNameToken(source, key))) continue
      hits.push(def.name || def.id)
      for (const field of DEFINITION_KINDS[kind].fields) {
        if (field === 'name' || field === 'match') continue
        const enabled = def.inject?.[field]
        if (enabled === false) continue
        if (DEFAULT_OFF_FIELDS.has(field) && enabled !== true) continue
        const value = String(def[field] ?? '').trim()
        if (!value) continue
        for (const tag of splitTags(value)) {
          const key = tag.toLowerCase()
          if (!key || have.has(key)) continue
          have.add(key)
          added.push(weight > 0 && weight !== 1 ? `(${tag}:${weight})` : tag)
        }
      }
    }
  }
  // 赤脚画面：负面里压一下鞋（鞋拿在手里时不压）。
  if (barefoot && !SHOES_IN_HAND.test(footText)) for (const tag of ['shoes', 'footwear']) if (!negatives.includes(tag)) negatives.push(tag)
  return { text: added.length ? `${source}, ${added.join(', ')}` : source, hits, negatives }
}

// =====================================================================
// 编译工作流
// =====================================================================

function setBinding(prompt, items, value) {
  for (const item of items ?? []) {
    const node = prompt[item.node]
    if (node && Object.hasOwn(node.inputs, item.input)) node.inputs[item.input] = value
  }
}

function applySize(prompt, size, sizes, bindings = null) {
  let target = sizes?.[size] ?? null
  if (!target) {
    // 规划模型给的"832x1216"这类像素尺寸直接用
    const hit = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(size ?? '').trim())
    if (hit) target = { width: Number(hit[1]), height: Number(hit[2]) }
  }
  if (!target) return null
  // 工作流绑定了尺寸节点时只改那几个；没绑定时改所有带宽高的节点，但跳过放大、缩放、裁剪一类节点
  // （两步出图里放大节点的目标尺寸被改成底图尺寸，放大那一步就白做了）。
  const sized = node => typeof node?.inputs?.width === 'number' && typeof node?.inputs?.height === 'number'
  const bound = [...new Set((bindings ?? []).map(item => item?.node))].map(id => prompt[id]).filter(sized)
  const nodes = bound.length ? bound : Object.values(prompt).filter(node => sized(node) && !/upscale|scale|resize|crop|pad/i.test(String(node.class_type ?? '')))
  if (!nodes.length) return null
  for (const node of nodes) { node.inputs.width = target.width; node.inputs.height = target.height }
  return target
}

function prepareImagePrompt({ workflow, params, config, definitions, onStage = null }) {
  const stage = (name, data) => { if (onStage) { try { onStage(name, data) } catch {} } }
  const tag = String(params.tag ?? '').trim()
  const artist = String(params.artist ?? '').trim()
  const backend = promptBackendContext(config, workflow)
  const mode = resolvePromptMode(config, backend)

  const rawBase = (params.artistPosition ?? config.artistPosition) === 'suffix'
    ? [tag, artist].filter(Boolean).join(', ')
    : [artist, tag].filter(Boolean).join(', ')
  const base = composePresetText([rawBase, String(config.promptManualPositive ?? '')].filter(Boolean).join(mode === 'tags' ? ', ' : '. '), config, backend)
  const provenance = onStage ? [] : null
  const injected = injectDefinitions(base, definitions, config, { style: mode === 'natural' ? 'natural' : 'tags', provenance, raw: params.rawTag })
  // 自然语言模型（LLM 文本编码器）不认 (tag:1.2) 这种权重，总是去掉；tag 模型按设置处理。
  const positive = formatPromptForBackend(applyWeights(injected.text, mode === 'natural' ? 'strip' : config.weightMode), backend, mode)
  stage('compile-positive', { mode, artistPosition: params.artistPosition ?? config.artistPosition, artist, rawBase, afterPreset: base, afterInjection: injected.text, final: positive, hits: injected.hits, provenance })

  const workflowNegative = String(
    workflow?.bindings.negative?.length
      ? workflow.prompt[workflow.bindings.negative[0].node]?.inputs?.[workflow.bindings.negative[0].input] ?? ''
      : '',
  )
  const pluginNegative = [activeArtistText(config).negative, promptPresetNegative(config), config.promptManualNegative, String(params.negative ?? '')].filter(Boolean).join(', ')
  const baseNegative = workflow ? ({
    plugin: pluginNegative,
    workflow: workflowNegative,
    merge: [workflowNegative, pluginNegative].filter(Boolean).join(', '),
  }[config.negativeMode] ?? pluginNegative) : pluginNegative
  // 工作流自带的负面词和插件的负面词常有重叠（merge 模式），按逗号分段去重，保留第一次出现的位置。
  const seenNegative = new Set()
  const mergedNegative = [baseNegative, ...(injected.negatives ?? [])].filter(Boolean).join(', ').split(',').map(t => t.trim()).filter(t => {
    const key = t.toLowerCase()
    if (!key || seenNegative.has(key)) return false
    seenNegative.add(key); return true
  }).join(', ')
  const negative = formatPromptForBackend(mergedNegative, backend, mode)
  stage('compile-negative', { negativeMode: config.negativeMode, workflowNegative, pluginNegative, characterNegatives: injected.negatives ?? [], final: negative })
  return { positive, negative, hits: injected.hits }
}

export function compileChannelJob({ params, config, definitions, onStage = null }) {
  const prepared = prepareImagePrompt({ params, config, definitions, onStage })
  const dimensions = config.sizes?.[params.size]
  const pixels = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(params.size ?? ''))
  const size = pixels ? { width: Number(pixels[1]), height: Number(pixels[2]) } : dimensions || { width: 832, height: 1216 }
  if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 64 && value <= 8192)) throw new Error('图片尺寸需在 64–8192 像素之间')
  return { ...prepared, seed: randomInt(0, 2 ** 32), size, loras: [] }
}

export function compileJob({ workflow, params, config, definitions, onStage = null }) {
  const prompt = structuredClone(workflow.prompt)
  const { positive, negative, hits } = prepareImagePrompt({ workflow, params, config, definitions, onStage })

  setBinding(prompt, workflow.bindings.positive, positive)
  if (workflow.bindings.negative?.length) setBinding(prompt, workflow.bindings.negative, applyWeights(negative, config.weightMode))

  const seed = Number.isSafeInteger(workflow.fixedSeed) && workflow.fixedSeed >= 0
    ? workflow.fixedSeed
    : randomInt(0, 2 ** 47)
  if (workflow.bindings.seed?.length) setBinding(prompt, workflow.bindings.seed, seed)

  for (const node of Object.values(prompt)) {
    if (Object.hasOwn(node.inputs ?? {}, 'batch_size') && typeof node.inputs.batch_size === 'number') node.inputs.batch_size = 1
  }

  // 应用 LoRA：按工作流自己的 LoRA 列表（在「画风」页里改）写回节点。
  // 停用一条 = 把两个权重都设 0（ComfyUI 里 0 就等于不生效），而不是删节点，保证连线不坏。
  const loraApplied = []
  for (const lora of workflow.bindings.loras ?? []) {
    const node = prompt[lora.node]
    if (!node || !node.inputs) continue
    if (lora.enabled === false) {
      if (Object.hasOwn(node.inputs, 'strength_model')) node.inputs.strength_model = 0
      if (Object.hasOwn(node.inputs, 'strength_clip')) node.inputs.strength_clip = 0
      loraApplied.push({ name: lora.name || ('节点 ' + lora.node), off: true })
      continue
    }
    if (lora.name && Object.hasOwn(node.inputs, 'lora_name')) node.inputs.lora_name = String(lora.name)
    const sm = Number(lora.strengthModel)
    const sc = Number(lora.strengthClip)
    if (Number.isFinite(sm) && Object.hasOwn(node.inputs, 'strength_model')) node.inputs.strength_model = sm
    if (Number.isFinite(sc) && Object.hasOwn(node.inputs, 'strength_clip')) node.inputs.strength_clip = sc
    loraApplied.push({ name: lora.name || ('节点 ' + lora.node), model: sm, clip: sc })
  }
  // 注意：这里不能打日志 —— compileJob 是模块级导出函数，拿不到 runtime 的日志器。

  if (config.overrideSteps) {
    if (params.steps !== undefined && params.steps !== '') setBinding(prompt, workflow.bindings.steps, Number(params.steps))
    // cfg 在有些工作流里绑成 guidance
    const cfgValue = Number(params.cfg)
    if (params.cfg !== undefined && params.cfg !== '' && Number.isFinite(cfgValue)) {
      if ((workflow.bindings.guidance ?? []).length) setBinding(prompt, workflow.bindings.guidance, cfgValue)
      if ((workflow.bindings.cfg ?? []).length) setBinding(prompt, workflow.bindings.cfg, cfgValue)
    }
  }

  const size = applySize(prompt, params.size, workflow.sizes ?? config.sizes ?? null, workflow.bindings?.size)
  return { prompt, seed, positive, negative, size, hits, workflowId: workflow.id, loras: loraApplied }
}

/** 挑工作流：先看锁定 / 默认，再按外部传来的 model 匹配 id / label / match。 */
function pickWorkflow(workflows, config, model) {
  const key = String(model ?? '').trim()
  if (!config.lockWorkflow && key) {
    for (const wf of workflows) {
      if (wf.id === key || wf.label === key || (wf.match ?? []).includes(key)) return wf
    }
  }
  return workflows.find(wf => wf.id === config.defaultWorkflow)
    ?? workflows.find(wf => !wf.error)
    ?? workflows[0]
    ?? null
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (response.headersSent || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.byteLength, 'cache-control': 'no-store' })
  response.end(body)
}
