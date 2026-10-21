import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))

const entry = (comment, keys, content) => ({ comment, keys, content, enabled: true })
const cardA = { raw: { name: '甲卡', data: { character_book: { entries: [
  entry('林晚', ['林晚', '晚晚'], '<character_information character="林晚">\n核心身份：\n  名称：林晚\n  性别：女\n  年龄：26岁\n外貌：黑色长发，杏眼，身形高挑，常穿米色针织衫和长裙。' + '。'.repeat(220)),
  entry('周屿', ['周屿'], '<character_information character="周屿">\n核心身份：\n  名称：周屿\n  性别：男\n  年龄：16岁\n  标签：高中生\n外貌：短发，校服。' + '。'.repeat(220)),
  entry('故事基调', [], '这是一个都市日常故事。'),
] } } } }
const cardB = { raw: { name: '乙卡', data: { character_book: { entries: [
  entry('沈月', ['沈月'], '姓名：沈月\n年龄：30\n外貌：银色短发，戴眼镜，穿西装。' + '。'.repeat(220)),
] } } } }

async function runtime(t) {
  const data = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
  const root = join(data, 'tools', 'dsh-tavern-image')
  await mkdir(join(root, 'workflows'), { recursive: true })
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 't', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify({ characters: [] }))
  await mkdir(join(data, 'resources', 'cards'), { recursive: true })
  await writeFile(join(data, 'resources', 'cards', 'a.json'), JSON.stringify(cardA))
  await writeFile(join(data, 'resources', 'cards', 'b.json'), JSON.stringify(cardB))
  // 最近玩的是乙卡：模型请求里留着乙卡的世界书正文
  await mkdir(join(data, 'model-requests', 'g1'), { recursive: true })
  await writeFile(join(data, 'model-requests', 'g1', 'r1.json'), JSON.stringify({ messages: [{ role: 'system', content: '常驻世界书\n姓名：沈月\n年龄：30\n身份关系：同事\n简介：银色短发，戴眼镜。' + '。'.repeat(420) }] }))
  const routes = new Map(), disposes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?' + Math.random())
  apply(ctx, { queryThrottleMs: 0 })
  t.after(async () => { for (const off of disposes.splice(0).reverse()) off(); await delay(40); await rm(data, { recursive: true, force: true }) })
  const request = (path, body) => new Promise(ok => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: '/plugins/dsh-tavern-image/' + path, headers: { host: 'localhost', 'content-type': 'application/json' } })
    routes.get(req.url)(req, { headersSent: false, setHeader() {}, writeHead(s) { this.status = s }, end(b) { ok({ status: this.status, body: JSON.parse(String(b)) }) } })
  })
  return { request, root }
}

test('从选定的卡导入只读那张卡：不带入最近玩过的别的卡，新人物绑定到这张卡，未成年人物跳过', async t => {
  const f = await runtime(t)
  const r = await f.request('import-characters', { card: 'cards/a.json' })
  assert.equal(r.body.ok, true, JSON.stringify(r.body))
  assert.deepEqual(r.body.added, ['林晚'])
  assert.deepEqual(r.body.skippedMinors, ['周屿'])
  const saved = JSON.parse(await readFile(join(f.root, 'definitions.json'), 'utf8')).characters
  assert.deepEqual(saved.map(c => c.name), ['林晚'])
  assert.deepEqual(saved[0].cards, ['cards/a.json'])
})

