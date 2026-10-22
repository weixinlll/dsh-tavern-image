import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPlannerSystem, parseImagePlan, parsePromptsBlock, formatPromptsBlock } from '../lib/planner.js'
import { selectPlannerContext } from '../lib/planner-context.js'
import { compileChannelJob } from '../lib/index.js'
import { generateImage } from '../lib/image-providers.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

function storedZip(name, contents) {
  const file = Buffer.from(name), crc = 0, size = contents.length
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(file.length, 26)
  const localRecord = Buffer.concat([local, file, contents])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(file.length, 28)
  const centralRecord = Buffer.concat([central, file])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralRecord.length, 12); end.writeUInt32LE(localRecord.length, 16)
  return Buffer.concat([localRecord, centralRecord, end])
}

const definitions = () => ({
  characters: [{
    id: 'c1', name: '小玉', match: 'xiao yu', enabled: true,
    traits: {
      feature: 'gentle', face: 'long black hair, blue eyes, pale skin, young woman',
      faceBack: 'long black hair, nape, pale skin, young woman',
      bodySFW: 'slender body, medium breasts', bodySFWBack: 'slim waist',
      lowerSFW: 'long legs', lowerSFWBack: 'rounded hips, long legs',
      bodyNSFW: '', bodyNSFWBack: '', lowerNSFW: '', lowerNSFWBack: '', negative: 'glasses',
    },
    outfits: [{ id: 'o1', name: 'white blouse', enabled: true, default: true, upper: 'white blouse', lower: 'black skirt', shoes: 'black heels', accessory: '' }],
    current: {},
  }],
})

const baseConfig = { imageBackend: 'novelai', promptMode: 'tags', traitMode: 'default', weightMode: 'keep', sizes: {} }
const params = {
  tag: '1girl, indoors, café',
  rawTag: '1girl, indoors, café',
  artist: '', negative: '', size: '832x1216',
  characters: [{ prompt: '${"name":"xiao yu","angle":"from front"}$', centers: 'C3', uc: 'glasses' }],
}
const channel = (extra = {}) => ({ provider: 'novelai', baseUrl: 'https://image.test', options: {}, ...extra })

test('分角色结构由世界书提供：种子条目只对 NovelAI 生效', () => {
  const book = JSON.parse(readFileSync(new URL('../世界书-通用生图规则.json', import.meta.url), 'utf8'))
  const entry = book.entries.find(item => /分角色提示词（NovelAI）/.test(item.comment))
  assert.ok(entry, '种子世界书里应有 NovelAI 分角色条目')
  assert.equal(entry.enabled, true)
  assert.deepEqual(entry.backends, ['novelai'])
  assert.match(entry.content, /<scene_composition>/)
  assert.match(entry.content, /<character_1>/)
  assert.match(entry.content, /<centers>/)
  assert.match(entry.content, /<uc>/)
  assert.match(entry.content, /\$\{/)

  const entries = book.entries.map((item, index) => ({ ...item, index }))
  const context = backend => selectPlannerContext({ entries, text: '正文', definitions: { characters: [] }, backend, promptMode: 'tags' })
  assert.match(context('novelai').staticRules, /分角色提示词（NovelAI）/)
  assert.doesNotMatch(context('comfyui').staticRules, /分角色提示词（NovelAI）/)
  assert.doesNotMatch(context('openai').staticRules, /分角色提示词（NovelAI）/)
})

test('插件不再自动往规划提示词里注入分角色结构', () => {
  const system = buildPlannerSystem({ rules: 'R', roster: '- A [stable_id=1]', count: 2 })
  assert.doesNotMatch(system, /<scene_composition>/)
  assert.doesNotMatch(system, /分角色提示词/)
})

test('parseImagePlan 拆出场景与角色块，老写法照旧', () => {
  const structured = '<images><image><regex>正文一句话</regex><title_styled>标题</title_styled><size>竖图</size>'
    + '<prompts><scene_composition>1girl, indoors, café</scene_composition>'
    + '<character_1><prompt>lin lan, black hair, white shirt</prompt><centers>C3</centers><uc>glasses</uc></character_1>'
    + '<character_2><prompt>tall man, grey t-shirt</prompt></character_2>'
    + '</prompts></image></images>'
  const [image] = parseImagePlan(structured)
  assert.equal(image.prompts, '1girl, indoors, café')
  assert.deepEqual(image.characters, [
    { prompt: 'lin lan, black hair, white shirt', centers: 'C3', uc: 'glasses' },
    { prompt: 'tall man, grey t-shirt', centers: '', uc: '' },
  ])
  const [legacy] = parseImagePlan('<images><image><regex>x</regex><prompts>1girl, solo, indoors</prompts></image></images>')
  assert.equal(legacy.prompts, '1girl, solo, indoors')
  assert.deepEqual(legacy.characters, [])
  // 只写 <scene_composition>、没包 <prompts> 时也不能把这张图丢掉
  const [sceneOnly] = parseImagePlan('<images><image><regex>x</regex><scene_composition>1girl, indoors</scene_composition></image></images>')
  assert.equal(sceneOnly.prompts, '1girl, indoors')
  assert.deepEqual(sceneOnly.characters, [])
})

test('场景 + 角色块可以往返格式化', () => {
  const text = formatPromptsBlock('1girl, indoors', [
    { prompt: 'lin lan, black hair', centers: 'C3', uc: 'glasses' },
    { prompt: 'tall man, grey t-shirt' },
  ])
  assert.match(text, /<scene_composition>1girl, indoors<\/scene_composition>/)
  assert.match(text, /<character_1>[\s\S]*<centers>C3<\/centers>/)
  const parsed = parsePromptsBlock(text)
  assert.equal(parsed.scene, '1girl, indoors')
  assert.equal(parsed.characters.length, 2)
  assert.equal(parsed.characters[0].centers, 'C3')
})

test('NovelAI 渠道：场景进 base，角色块展开宏后单独成分区', () => {
  const compiled = compileChannelJob({ params, config: baseConfig, definitions: definitions(), channel: channel() })
  assert.equal(compiled.positive, '1girl, indoors, café')
  assert.equal(compiled.characters.length, 1)
  assert.match(compiled.characters[0].prompt, /long black hair/)
  assert.match(compiled.characters[0].prompt, /white blouse/)
  assert.doesNotMatch(compiled.characters[0].prompt, /\$\{/)
  assert.equal(compiled.characters[0].centers, 'C3')
  assert.match(compiled.characters[0].uc, /glasses/)
})

test('其它渠道：角色块合并回一条提示词，不发分区', () => {
  const config = { ...baseConfig, imageBackend: 'openai', promptMode: 'natural' }
  const compiled = compileChannelJob({ params, config, definitions: definitions(), channel: { provider: 'openai', options: {} } })
  assert.deepEqual(compiled.characters, [])
  assert.match(compiled.positive, /long black hair/)
  assert.match(compiled.positive, /1girl, indoors, café/)
})

test('NovelAI 对话格式中转没有 v4_prompt，角色块也合并回主提示词', () => {
  const compiled = compileChannelJob({ params, config: baseConfig, definitions: definitions(), channel: channel({ options: { protocol: 'chat' } }) })
  assert.deepEqual(compiled.characters, [])
  assert.match(compiled.positive, /long black hair/)
})

test('NovelAI 请求体：char_captions、坐标全有才开、角色负面进 v4_negative', async () => {
  const zip = storedZip('result.png', png)
  let body = null
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return new Response(zip) }
  await generateImage(channel(), {
    positive: '1girl, indoors, café', negative: 'blurry', width: 832, height: 1216, seed: 1,
    characters: [
      { prompt: 'lin lan, black hair', centers: 'C3', uc: 'glasses' },
      { prompt: 'tall man, grey t-shirt', centers: 'D4', uc: '' },
    ],
  }, { fetchImpl })
  assert.equal(body.parameters.v4_prompt.use_coords, true)
  assert.deepEqual(body.parameters.v4_prompt.caption.char_captions, [
    { char_caption: 'lin lan, black hair', centers: [{ x: 0.5, y: 0.5 }] },
    { char_caption: 'tall man, grey t-shirt', centers: [{ x: 0.7, y: 0.7 }] },
  ])
  assert.deepEqual(body.parameters.v4_negative_prompt.caption.char_captions, [
    { char_caption: 'glasses', centers: [{ x: 0.5, y: 0.5 }] },
    { char_caption: '', centers: [{ x: 0.7, y: 0.7 }] },
  ])
  assert.equal(body.parameters.characterPrompts.length, 2)
})

test('NovelAI 请求体：有角色没写坐标时整张不用坐标', async () => {
  const zip = storedZip('result.png', png)
  let body = null
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return new Response(zip) }
  await generateImage(channel(), {
    positive: '1girl, indoors', negative: '', width: 832, height: 1216,
    characters: [{ prompt: 'lin lan', centers: 'C3' }, { prompt: 'tall man' }],
  }, { fetchImpl })
  assert.equal(body.parameters.v4_prompt.use_coords, false)
  assert.deepEqual(body.parameters.v4_prompt.caption.char_captions.map(item => item.centers), [[{ x: 0.5, y: 0.5 }], [{}]])
})
