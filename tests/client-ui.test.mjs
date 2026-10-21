import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.__test = { SettingsPanel, InlineImage, OfficialImage, PromptEditor, validMediaContext, createHistoryRequestEpoch, indexedHistoryChanges }')
const packageName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
const flush = () => new Promise(resolve => setImmediate(resolve))
const copy = value => JSON.parse(JSON.stringify(value))
const person = (id, name) => ({ id, name, match: '', note: '', continuity: '', enabled: true, cards: [], outfitRefs: [], traits: { feature: 'gentle', face: 'black hair' }, outfits: [] })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness(extra = {}, characters = [person('a', '甲'), person('b', '乙')]) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let api
  let moduleId
  let tree
  let state = { config: {}, workflows: [], outfits: [], definitions: { characters: copy(characters), outfits: [] }, tasks: [{ id: 'task', state: 'running', startedAt: Date.now() }] }
  const requests = []
  const intervals = []
  const timeouts = []
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], update => { hooks[index] = typeof update === 'function' ? update(hooks[index]) : update }]
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index] },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) pendingEffects.push(effect)
      hooks[index] = deps
    },
  }
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, addEventListener() {}, __ModuleLoader__: { load({ id, factory }) { moduleId = id; api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' },
    document: { baseURI: 'http://test.local', createElement() { return { files: [{ type: 'image/png', name: 'ref.png' }], click() { this.onchange() } } } },
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,test'; this.onload() } },
    confirm: () => true,
    URL, console, Date, Math, Promise, TypeError,
    setInterval(callback) { intervals.push(callback); return intervals.length }, clearInterval() {},
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length }, clearTimeout() {},
    async fetch(url, init = {}) {
      const parsedUrl = new URL(url)
      const path = parsedUrl.pathname.split('/').at(-1)
      const body = init.body ? JSON.parse(init.body) : null
      const method = init.method || 'GET'
      const query = Object.fromEntries(parsedUrl.searchParams)
      requests.push({ path, pathname: parsedUrl.pathname, method, query, body })
      let result
      if (extra[path]) result = await extra[path]({ body, query, method, state, setState: next => { state = next } })
      else if (path === 'state') result = copy(state)
      else if (path === 'definitions') { state = { ...state, definitions: copy(body.definitions), outfits: copy(body.definitions.outfits) }; result = { ok: true, state: copy(state) } }
      else if (path === 'cards') result = { ok: true, cards: [{ path: 'cards/story.json', name: '故事卡' }] }
      else result = { ok: true }
      return { ok: true, status: 200, json: async () => result }
    },
  }
  vm.runInNewContext(source, context)
  const nodes = root => {
    if (!root || typeof root !== 'object') return []
    return [root, ...(root.children || []).flatMap(nodes)]
  }
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  function render() {
    cursor = 0
    pendingEffects = []
    tree = api.__test.SettingsPanel()
    pendingEffects.forEach(effect => effect())
    return tree
  }
  function renderComponent(component, props = {}) {
    cursor = 0
    pendingEffects = []
    tree = component(props)
    pendingEffects.forEach(effect => effect())
    return tree
  }
  function find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, '找不到 UI 元素'); return node }
  function button(label) { return find(node => node.type === 'button' && text(node) === label) }
  function input(label) { return find(node => node.props['aria-label'] === label) }
  function selectRole(id) {
    const selector = find(node => node.type === 'select' && node.props['aria-label'] === '当前角色')
    if (selector.props.value !== id) {
      selector.props.onChange({ target: { value: id } })
      render()
    }
  }
  function role(id) {
    selectRole(id)
    return find(node => node.type === 'details' && node.props.key === id)
  }
  function rolePanels() { return nodes(tree).filter(node => node.type === 'details' && node.props.key != null) }
  function roleInput(id, placeholder) {
    return nodes(role(id)).find(node => node.props.placeholder === placeholder)
  }
  async function ready() {
    render(); await flush(); render()
    button('人物库').props.onClick(); render(); await flush(); render()
  }
  async function openPluginUpdate() {
    await ready()
    button('插件更新').props.onClick(); render(); await flush(); render()
  }
  return { React, api, moduleId, ready, openPluginUpdate, render, renderComponent, button, input, role, roleInput, rolePanels, nodes, text, intervals, timeouts, requests, get state() { return state } }
}

test('client module registration matches the package key DSH uses to load it', () => {
  assert.equal(packageName, 'dsh-tavern-image')
  assert.equal(harness().moduleId, packageName)
})

test('message draw runs once per game and turn, stays independent across turns, and unlocks after completion', async () => {
  const first = deferred()
  const sent = []
  const starts = []
  const runner = harness().api.__test.createMessageDrawRunner(context => {
    sent.push({ gameId: context.gameId, turn: context.turn })
    return sent.length === 1 ? first.promise : Promise.resolve({ ok: true })
  }, context => starts.push([context.gameId, context.turn]))
  const a = runner({ gameId: 'g1', turn: 2 })
  const duplicate = runner({ gameId: 'g1', turn: 2 })
  const otherTurn = runner({ gameId: 'g1', turn: 3 })
  const otherGame = runner({ gameId: 'g2', turn: 2 })
  await flush()
  assert.equal(a, duplicate)
  assert.deepEqual(sent, [{ gameId: 'g1', turn: 2 }, { gameId: 'g1', turn: 3 }, { gameId: 'g2', turn: 2 }])
  assert.deepEqual(starts, [['g1', 2], ['g1', 3], ['g2', 2]])
  first.resolve({ ok: true })
  await Promise.all([a, duplicate, otherTurn, otherGame])
  await runner({ gameId: 'g1', turn: 2 })
  assert.equal(sent.filter(item => item.gameId === 'g1' && item.turn === 2).length, 2, '结束后用户可以再次发起绘图')
})

test('图片说明交由 Tavern 渲染，插件保留 alt 且不重复显示 caption', () => {
  const ui = harness()
  const image = ui.api.__test.OfficialImage({ item: { status: 'ready', caption: '[客籍关前验魂灰]', url: '/image.png', data: { jobId: 'j1' } } })
  assert.equal(ui.nodes(image).filter(node => node.type === 'img')[0].props.alt, '[客籍关前验魂灰]')
  assert.equal(ui.text(image), '')
  assert.equal(ui.nodes(image).some(node => node.type === 'button'), false)
})

test('正文内图片遇到终态失败后，手动重试会重新提交同一个 key', async () => {
  let submissions = 0
  const ui = harness({
    jobs: ({ query, body }) => {
      if (body) {
        submissions++
        return { id: 'new-inline-job', status: 'pending' }
      }
      if (query.key) return { ok: true, job: { id: 'old-inline-job', status: 'failed', error: 'ComfyUI 没开' } }
      return { ok: true, job: { id: 'new-inline-job', status: 'done' } }
    },
  })
  let tree = ui.renderComponent(ui.api.__test.InlineImage, { prompt: 'portrait', imageKey: 'same-inline-key', auto: true })
  await flush(); await flush()
  tree = ui.renderComponent(ui.api.__test.InlineImage, { prompt: 'portrait', imageKey: 'same-inline-key', auto: true })
  assert.equal(submissions, 0, 'a previously failed historical image must not resubmit automatically')
  const retry = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重试')
  assert.ok(retry)
  retry.props.onClick()
  tree = ui.renderComponent(ui.api.__test.InlineImage, { prompt: 'portrait', imageKey: 'same-inline-key', auto: true })
  await flush(); await flush()
  assert.equal(submissions, 1)
  assert.ok(ui.requests.some(request => request.path === 'jobs' && request.method === 'POST' && request.body.key === 'same-inline-key'))
})

test('失败占位支持点击、右键和长按打开提示词编辑器', async () => {
  const ui = harness({ 'job-detail': () => ({ ok: true, job: { id: 'job-failed-placeholder', rawPrompt: '原提示词', state: 'failed' } }) })
  ui.renderComponent(ui.api.__test.PromptEditor)
  const props = { gameId: 'game-placeholder', turn: 11, item: { id: 'media-placeholder', textVersion: 'text-v11', status: 'failed', caption: '当前图片', error: '生成失败', data: { jobId: 'job-failed-placeholder' } } }
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const placeholder = ui.nodes(tree).find(node => node.props.key === 'illustration-placeholder')
  assert.ok(placeholder)
  assert.match(ui.text(placeholder), /点这里改提示词重画/)

  placeholder.props.onClick()
  await flush()
  let editor = ui.renderComponent(ui.api.__test.PromptEditor)
  assert.equal(ui.nodes(editor).find(node => node.type === 'textarea')?.props.value, '原提示词')

  let prevented = false
  let stopped = false
  placeholder.props.onContextMenu({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  await flush()
  ui.renderComponent(ui.api.__test.PromptEditor)

  placeholder.props.onTouchStart()
  const longPress = ui.timeouts.findLast(timer => timer.delay === 550)
  assert.ok(longPress)
  longPress.callback()
  await flush()
  editor = ui.renderComponent(ui.api.__test.PromptEditor)
  assert.equal(ui.nodes(editor).find(node => node.type === 'textarea')?.props.value, '原提示词')
})

test('平台可能仍在生成的取消保持重画锁，直到只读查询确认终态', async () => {
  const ui = harness({
    'media-action': ({ body }) => body.operation === 'cancel'
      ? ({ ok: true, jobId: body.jobId, state: 'cancelled', requestStarted: true, cancelMayHaveContinued: true })
      : ({ ok: true, jobId: body.jobId, state: 'done' }),
    'job-detail': ({ query }) => ({ ok: true, job: { id: query.id, state: 'cancelled', requestStarted: true } }),
  })
  ui.renderComponent(ui.api.__test.PromptEditor)
  const props = { gameId: 'game-cancel-retry', turn: 12, item: { id: 'media-cancel-retry', textVersion: 'text-v12', status: 'pending', data: { jobId: 'job-cancel-retry' } } }
  let tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  await ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '取消这张图').props.onClick()
  assert.equal(ui.api.__test.hasUncertainMediaAction('media-cancel-retry'), true)
  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.ok(ui.nodes(tree).some(node => node.type === 'button' && ui.text(node) === '重新查询状态'))
  const imageOrPlaceholder = ui.nodes(tree).find(node => node.type === 'img') || ui.nodes(tree).find(node => node.props.key === 'illustration-placeholder')
  imageOrPlaceholder.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
  await flush()
  const editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const redraw = ui.nodes(editor).find(node => node.type === 'button' && /用这段重画/.test(ui.text(node)))
  assert.ok(redraw)
  assert.equal(redraw.props.disabled, true)
  assert.equal(ui.requests.filter(request => request.path === 'media-action').length, 1)
  await ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重新查询状态').props.onClick()
  const actions = ui.requests.filter(request => request.path === 'media-action')
  assert.deepEqual(actions.map(request => request.body.operation), ['cancel', 'recover'])
})

test('恢复仍返回有风险的 cancelled 时，job-detail 轮询也不会解开重画锁', async () => {
  const ui = harness({
    'media-action': ({ body }) => ({ ok: true, jobId: body.jobId, state: 'cancelled', requestStarted: true, cancelMayHaveContinued: true }),
    'job-detail': ({ query }) => ({ ok: true, job: { id: query.id, rawPrompt: '原提示词', state: 'cancelled', requestStarted: true, cancelMayHaveContinued: true } }),
  })
  ui.renderComponent(ui.api.__test.PromptEditor)
  const props = {
    gameId: 'game-cancel-unconfirmed', turn: 13,
    item: { id: 'media-cancel-unconfirmed', textVersion: 'text-v13', status: 'ready', url: '/old.png', data: { jobId: 'job-cancel-unconfirmed', replacement: { jobId: 'job-cancel-unconfirmed', state: 'cancelled', requestStarted: true, cancelMayHaveContinued: true } } },
  }
  let tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  await flush()
  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const recover = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重新查询状态')
  assert.ok(recover)
  await recover.props.onClick()
  assert.equal(ui.api.__test.hasUncertainMediaAction('media-cancel-unconfirmed'), true)

  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  await flush()
  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.equal(ui.api.__test.hasUncertainMediaAction('media-cancel-unconfirmed'), true)
  ui.nodes(tree).find(node => node.type === 'img').props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
  await flush()
  const editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const redraw = ui.nodes(editor).find(node => node.type === 'button' && /用这段重画/.test(ui.text(node)))
  assert.ok(redraw)
  assert.equal(redraw.props.disabled, true)
  assert.equal(ui.requests.filter(request => request.path === 'media-action').length, 1)
})

test('画风预设和展开的世界书编辑器使用明确的深色表面与可读文字', async () => {
  const ui = harness({
    state: ({ state }) => ({ ...copy(state), config: { stylePresets: [{ id: 'p1', name: '夜景', artist: 'cinematic', negative: '', enabled: true }], activePreset: 'p1' }, worldbook: [{ index: 0, enabled: true, comment: '测试条目', content: '规则内容', length: 4, activation: 'always' }] }),
  })
  await ui.ready()
  ui.button('画风').props.onClick(); ui.render()
  let presetTree = ui.render()
  const presetCard = ui.nodes(presetTree).find(node => node.type === 'div' && node.props.key === 'p1')
  assert.equal(presetCard.props.style.background, '#1b2a3e')
  assert.equal(presetCard.props.style.color, '#e8edf5')

  ui.button('世界书').props.onClick(); ui.render()
  const edit = ui.nodes(ui.render()).find(node => node.type === 'button' && ui.text(node) === '编辑')
  edit.props.onClick(); const worldbookTree = ui.render()
  const entryCard = ui.nodes(worldbookTree).find(node => node.props.style?.background === '#1a2029')
  assert.ok(entryCard)
  const editorArea = ui.nodes(entryCard).find(node => node.type === 'textarea')
  assert.equal(editorArea.props.style.background, '#1a2029')
  assert.equal(editorArea.props.style.color, '#e8edf5')
})

test('官方媒体渲染器在上下文无效时禁用单图操作，并保留旧图显示替换状态', () => {
  const ui = harness()
  const old = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 4,
    item: { id: 'media-1', textVersion: 'text-v2', status: 'ready', url: '/old.png', data: { jobId: 'job-old', replacement: { jobId: 'job-new', state: 'running' } } },
  })
  assert.equal(ui.nodes(old).find(node => node.type === 'img').props.src, '/old.png')
  assert.match(ui.text(old), /替换任务生成中/)
  assert.equal(ui.nodes(old).filter(node => node.type === 'button' && ui.text(node) === '取消这张图').length, 1)

  const invalid = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: '', turn: 4,
    item: { id: 'media-1', textVersion: 'text-v2', status: 'ready', url: '/old.png', data: { jobId: 'job-old' } },
  })
  assert.equal(ui.nodes(invalid).filter(node => node.type === 'button').length, 0)
})

test('官方媒体单图取消只提交目标 media 一次；不确定状态不会暴露重试', async () => {
  const waiting = deferred()
  const ui = harness({ 'media-action': () => waiting.promise })
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 4,
    item: { id: 'media-target', textVersion: 'text-v2', status: 'ready', url: '/old.png', data: { jobId: 'job-target', replacement: { jobId: 'job-replacing', state: 'pending' } } },
  })
  const cancel = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '取消这张图')
  const first = cancel.props.onClick()
  const second = cancel.props.onClick()
  assert.equal(ui.requests.filter(request => request.path === 'media-action').length, 1)
  assert.deepEqual(ui.requests.find(request => request.path === 'media-action').body, {
    operation: 'cancel', gameId: 'game-1', turn: 4, textVersion: 'text-v2', mediaId: 'media-target', jobId: 'job-replacing',
  })
  assert.equal(ui.requests.find(request => request.path === 'job-detail').query.id, 'job-replacing')
  waiting.resolve({ ok: true, state: 'cancelled' }); await Promise.all([first, second])

  const uncertainUi = harness()
  const uncertain = uncertainUi.renderComponent(uncertainUi.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 4,
    item: { id: 'media-uncertain', textVersion: 'text-v2', status: 'ready', url: '/old.png', data: { jobId: 'job-uncertain', replacement: { jobId: 'job-possible', state: 'uncertain' } } },
  })
  assert.match(uncertainUi.text(uncertain), /状态待确认/)
  assert.equal(uncertainUi.nodes(uncertain).some(node => node.type === 'button' && /重试/.test(uncertainUi.text(node))), false)
})

test('原始生成中的图片可按其 jobId 取消；已取消但可能已提交平台的状态会明示', async () => {
  const ui = harness({ 'media-action': ({ body }) => ({ ok: true, jobId: body.jobId, state: 'cancelled', requestStarted: true }) })
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 5,
    item: { id: 'media-initial-cancel', textVersion: 'text-v4', status: 'pending', data: { jobId: 'job-initial' } },
  })
  const cancel = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '取消这张图')
  assert.ok(cancel)
  await cancel.props.onClick()
  const request = ui.requests.find(item => item.path === 'media-action')
  assert.equal(request.body.operation, 'cancel')
  assert.equal(request.body.mediaId, 'media-initial-cancel')
  assert.equal(request.body.jobId, 'job-initial')
  assert.equal(ui.requests.find(item => item.path === 'job-detail').query.id, 'job-initial')
  const updated = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 5,
    item: { id: 'media-initial-cancel', textVersion: 'text-v4', status: 'failed', data: { jobId: 'job-initial', cancelled: true, cancelMayHaveContinued: true } },
  })
  assert.match(ui.text(updated), /平台请求可能已发出/)
})

test('取消返回待确认时不会提示已取消；replacement 持久化警告不依赖 job-detail', async () => {
  const ui = harness({ 'media-action': ({ body }) => ({ ok: true, jobId: body.jobId, state: 'uncertain', requestStarted: true }) })
  const messages = []
  ui.api.__test.setToastForTest((message, kind) => messages.push({ message, kind }))
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 7,
    item: { id: 'media-cancel-uncertain', textVersion: 'text-v7', status: 'pending', data: { jobId: 'job-cancel-uncertain' } },
  })
  const cancel = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '取消这张图')
  await cancel.props.onClick()
  assert.equal(messages.at(-1).kind, 'fail')
  assert.match(messages.at(-1).message, /状态待确认/)
  assert.doesNotMatch(messages.at(-1).message, /已取消这张图/)

  const persistedUi = harness()
  const persisted = persistedUi.renderComponent(persistedUi.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 7,
    item: { id: 'media-cancel-uncertain', textVersion: 'text-v7', status: 'ready', url: '/old.png', data: { jobId: 'job-old', replacement: { jobId: 'job-replacement', state: 'cancelled', cancelMayHaveContinued: true, requestStarted: true, error: '平台响应未确认' } } },
  })
  assert.match(persistedUi.text(persisted), /平台请求可能已发出并继续生成/)
  assert.match(persistedUi.text(persisted), /平台响应未确认/)

  const cancelledUi = harness()
  const safelyCancelled = cancelledUi.renderComponent(cancelledUi.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 7,
    item: { id: 'media-safe-cancel', textVersion: 'text-v7', status: 'ready', url: '/old.png', data: { jobId: 'job-old', replacement: { jobId: 'job-cancelled', state: 'cancelled', cancelMayHaveContinued: false, requestStarted: false, error: '已取消' } } },
  })
  assert.match(cancelledUi.text(safelyCancelled), /已取消/)
  assert.doesNotMatch(cancelledUi.text(safelyCancelled), /平台请求可能已发出并继续生成/)
})

test('provider 结果不确定时即使 job 标为 failed 也不显示付费重试', async () => {
  const ui = harness({ 'job-detail': ({ }) => ({ ok: true, job: { id: 'provider-uncertain-job', state: 'failed', requestStarted: true, requestMayHaveSucceeded: true, providerTaskId: 'platform-job-7' } }) })
  const props = {
    gameId: 'game-1', turn: 6,
    item: { id: 'media-uncertain-provider', textVersion: 'text-v5', status: 'ready', url: '/old.png', data: { jobId: 'old-provider-job', replacement: { jobId: 'provider-uncertain-job', state: 'failed' } } },
  }
  ui.renderComponent(ui.api.__test.OfficialImage, props)
  await flush(); await flush()
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.match(ui.text(tree), /平台任务 platform-job-7/)
  assert.equal(ui.nodes(tree).some(node => node.type === 'button' && /重试/.test(ui.text(node))), false)
})

test('旧 ComfyUI 不确定作业没有平台任务号时显示正文重生图指引且不渲染破图', async () => {
  const ui = harness({
    'job-detail': ({ query }) => ({ ok: true, job: { id: query.id, state: 'uncertain', backend: 'comfyui', requestMayHaveSucceeded: true, comfyId: '' } }),
  })
  const props = {
    gameId: 'game-legacy-comfy', turn: 4,
    item: { id: 'media-legacy-comfy', textVersion: 'text-v4', status: 'pending', data: { jobId: 'job-legacy-comfy' } },
  }
  ui.renderComponent(ui.api.__test.OfficialImage, props)
  await flush(); await flush()
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.equal(ui.nodes(tree).some(node => node.type === 'img'), false)
  assert.match(ui.text(tree), /没有保存 ComfyUI 任务号/)
  assert.match(ui.text(tree), /正文末重新生图/)
  assert.equal(ui.nodes(tree).some(node => node.type === 'button' && ui.text(node) === '重新查询状态'), false)
})

test('确认失败的 ComfyUI 媒体仍提供单图重试操作', async () => {
  const ui = harness({
    'job-detail': ({ query }) => ({ ok: true, job: { id: query.id, state: 'failed', backend: 'comfyui', requestMayHaveSucceeded: false } }),
    'media-action': ({ body }) => ({ ok: true, jobId: 'fresh-comfy-job', mediaId: body.mediaId, state: 'pending' }),
  })
  const props = {
    gameId: 'game-retry-comfy', turn: 5,
    item: { id: 'media-retry-comfy', textVersion: 'text-v5', status: 'failed', data: { jobId: 'failed-comfy-job' } },
  }
  ui.renderComponent(ui.api.__test.OfficialImage, props)
  await flush(); await flush()
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const retry = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重试这张图')
  assert.ok(retry)
  await retry.props.onClick()
  const action = ui.requests.find(request => request.path === 'media-action')
  assert.equal(action.body.operation, 'retry')
  assert.equal(action.body.jobId, 'failed-comfy-job')
})

test('不确定图片可只读重新查询；找回结果后恢复单图并用新 job 取图', async () => {
  const ui = harness({
    'media-action': ({ body }) => ({ ok: true, ...body, jobId: 'recovered-job', state: 'ready' }),
    'job-detail': ({ query }) => ({ ok: true, job: { id: query.id, rawPrompt: 'new prompt', state: 'done' } }),
  })
  const props = {
    gameId: 'game-1', turn: 8,
    item: { id: 'media-recover', textVersion: 'text-v8', status: 'ready', url: '/old.png', data: { jobId: 'job-old', replacement: { jobId: 'job-uncertain', state: 'uncertain' } } },
  }
  let tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const recover = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重新查询状态')
  assert.ok(recover)
  await recover.props.onClick()
  const request = ui.requests.find(entry => entry.path === 'media-action')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.body, { operation: 'recover', gameId: 'game-1', turn: 8, textVersion: 'text-v8', mediaId: 'media-recover', jobId: 'job-uncertain' })
  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.equal(ui.nodes(tree).find(node => node.type === 'img').props.src, 'http://test.local/plugins/dsh-tavern-image/jobs?id=recovered-job&image=1')
  assert.equal(ui.nodes(tree).some(node => node.type === 'button' && ui.text(node) === '重新查询状态'), false)
  assert.equal(ui.nodes(tree).some(node => node.type === 'button' && ui.text(node) === '重画'), false, '宿主尚未发布新 job 到媒体记录时隐藏编辑操作')

  const updatedProps = { ...props, item: { ...props.item, status: 'ready', data: { jobId: 'recovered-job', replacement: { jobId: 'recovered-job', state: 'ready' } } } }
  tree = ui.renderComponent(ui.api.__test.OfficialImage, updatedProps)
  assert.equal(ui.nodes(tree).some(node => node.type === 'button'), false, '已完成的图保持安静显示，不挂编辑工具栏')
  ui.renderComponent(ui.api.__test.PromptEditor)
  const recoveredImage = ui.nodes(tree).find(node => node.type === 'img')
  let prevented = false
  let stopped = false
  recoveredImage.props.onContextMenu({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  await flush()
  let detail = ui.requests.filter(entry => entry.path === 'job-detail').at(-1)
  assert.equal(detail.query.id, 'recovered-job')
})

test('状态轮询必须匹配当前 job id 才能解除不确定付费锁', async () => {
  const ui = harness({
    'media-action': () => { throw new TypeError('request timed out') },
    'job-detail': () => ({ ok: true, job: { id: 'different-job', state: 'done' } }),
  })
  const props = { gameId: 'game-1', turn: 10, item: { id: 'media-lock', textVersion: 'text-v10', status: 'pending', data: { jobId: 'job-lock' } } }
  const tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const cancel = ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '取消这张图')
  await cancel.props.onClick()
  await flush(); await flush()
  assert.equal(ui.api.__test.hasUncertainMediaAction('media-lock'), true)
})

test('明确未提交的校验错误不把单图永久锁为待确认', async () => {
  let attempts = 0
  const ui = harness({ 'media-action': ({ body }) => {
    attempts += 1
    return attempts === 1 ? { ok: false, code: 'REJECTED', submissionNotStarted: true, error: '渠道无效' } : { ok: true, jobId: 'retry-job', mediaId: body.mediaId, state: 'pending' }
  } })
  const props = { gameId: 'game-1', turn: 9, item: { id: 'media-validation', textVersion: 'text-v9', status: 'failed', data: { jobId: 'old-job' } } }
  let tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  const retry = () => ui.nodes(tree).find(node => node.type === 'button' && ui.text(node) === '重试这张图')
  await retry().props.onClick()
  tree = ui.renderComponent(ui.api.__test.OfficialImage, props)
  assert.ok(retry())
  await retry().props.onClick()
  assert.equal(attempts, 2)
})

test('官方媒体提示词编辑器携带完整上下文和本次渠道，成功只报告已提交', async () => {
  const ui = harness({
    state: () => ({ ok: true, config: { imageChannels: [{ id: 'channel-2', name: '备用通道' }] } }),
    'job-detail': () => ({ ok: true, job: { rawPrompt: 'old prompt', negative: 'bad', state: 'done' } }),
    'media-action': () => ({ ok: true, jobId: 'job-next', mediaId: 'media-1', state: 'pending' }),
  })
  ui.renderComponent(ui.api.__test.PromptEditor)
  const image = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 9,
    item: { id: 'media-1', textVersion: 'text-v3', status: 'ready', url: '/old.png', data: { jobId: 'job-old' } },
  })
  const renderedImage = ui.nodes(image).find(node => node.type === 'img')
  assert.equal(ui.nodes(image).some(node => node.type === 'button'), false)
  renderedImage.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
  await flush()
  ui.renderComponent(ui.api.__test.PromptEditor)
  let editor = ui.renderComponent(ui.api.__test.PromptEditor)
  assert.equal(ui.nodes(editor).find(node => node.type === 'textarea')?.props.value, 'old prompt')
  ui.renderComponent(ui.api.__test.PromptEditor)
  // 通过编辑器原有渠道字段选择要用于这次重画的渠道。
  const channel = ui.nodes(editor).find(node => node.type === 'select' && node.props['aria-label'] === '本次生图渠道')
  assert.ok(channel)
  channel.props.onChange({ target: { value: 'channel-2' } })
  editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const submit = ui.nodes(editor).find(node => node.type === 'button' && /用这段重画/.test(ui.text(node)))
  const pending = submit.props.onClick()
  editor = ui.renderComponent(ui.api.__test.PromptEditor)
  assert.equal(ui.nodes(editor).find(node => node.type === 'button' && /提交中/.test(ui.text(node))).props.disabled, true)
  await pending
  editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const request = ui.requests.find(item => item.path === 'media-action')
  assert.deepEqual(request.body, {
    operation: 'redraw', gameId: 'game-1', turn: 9, textVersion: 'text-v3', mediaId: 'media-1', jobId: 'job-old',
    prompt: 'old prompt', negative: 'bad', channelId: 'channel-2',
  })
  assert.match(ui.text(editor), /已提交重画/)
  assert.doesNotMatch(ui.text(editor), /重画完成/)
})

test('单图重画请求超时后标记待确认并禁止再次付费提交', async () => {
  const ui = harness({
    'job-detail': () => ({ ok: true, job: { rawPrompt: 'old prompt', negative: '' } }),
    'media-action': () => { throw new TypeError('connection timed out') },
  })
  ui.renderComponent(ui.api.__test.PromptEditor)
  const image = ui.renderComponent(ui.api.__test.OfficialImage, {
    gameId: 'game-1', turn: 10,
    item: { id: 'media-timeout-unique', textVersion: 'text-v3', status: 'ready', url: '/old.png', data: { jobId: 'job-timeout-source' } },
  })
  ui.nodes(image).find(node => node.type === 'img').props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
  await flush()
  let editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const redraw = ui.nodes(editor).find(node => node.type === 'button' && /用这段重画/.test(ui.text(node)))
  await redraw.props.onClick()
  editor = ui.renderComponent(ui.api.__test.PromptEditor)
  const afterTimeout = ui.nodes(editor).find(node => node.type === 'button' && /用这段重画/.test(ui.text(node)))
  assert.match(ui.text(editor), /状态待确认/)
  assert.equal(afterTimeout.props.disabled, true)
  await afterTimeout.props.onClick()
  assert.equal(ui.requests.filter(request => request.path === 'media-action').length, 1)
})

test('history requests become stale as soon as the panel switches games', () => {
  const ui = harness()
  const requests = ui.api.__test.createHistoryRequestEpoch()
  const oldRequest = requests.begin('game-a')
  const oldRestore = requests.captureGame('game-a')
  requests.activate('game-b')
  const currentRequest = requests.begin('game-b')
  assert.equal(requests.isCurrent('game-a', oldRequest), false)
  assert.equal(requests.isGameCurrent('game-a', oldRestore), false)
  assert.equal(requests.isCurrent('game-b', currentRequest), true)
  requests.invalidate('game-b')
  assert.equal(requests.isCurrent('game-b', currentRequest), false)
})

test('history restore rows keep the displayed event paired with its actual snapshot index', () => {
  const ui = harness()
  const changes = [
    { id: 'role-a', field: 'face', turn: 1, at: 10, before: 'black hair', after: 'white hair' },
    { id: 'role-b', field: 'feature', turn: 2, at: 20, before: 'quiet', after: 'scarred' },
  ]
  const rows = ui.api.__test.indexedHistoryChanges(changes)
  assert.deepEqual(rows.map(row => row.index), [1, 0])
  assert.deepEqual(rows.map(row => row.change), [changes[1], changes[0]])
  // These are the exact two values the panel forwards to restore(index, expectedChange).
  const firstRowPost = { changeIndex: rows[0].index, expectedChange: rows[0].change }
  assert.equal(firstRowPost.changeIndex, 1)
  assert.deepEqual(firstRowPost.expectedChange, changes[1])
})

test('当前角色折叠/展开与切换保留草稿；批量覆盖/追加只作用于所选角色，手动保存才写入', async () => {
  const ui = harness()
  await ui.ready()
  assert.equal(ui.rolePanels().length, 1)
  assert.equal(ui.role('a').props.open, true)
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '甲改名' } }); ui.render()
  ui.button('收起编辑').props.onClick(); ui.render()
  assert.equal(ui.role('a').props.open, false)
  assert.equal(ui.roleInput('a', '角色名').props.value, '甲改名')
  ui.button('展开编辑').props.onClick(); ui.render()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙草稿' } }); ui.render()
  ui.roleInput('a', '角色名')
  assert.equal(ui.roleInput('a', '角色名').props.value, '甲改名')
  assert.equal(ui.roleInput('b', '角色名').props.value, '乙草稿')
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.input('批量选择角色 甲改名').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: 'cold' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'definitions').length, 0)
  ui.input('批量编辑方式').props.onChange({ target: { value: 'append' } }); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: 'elegant' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.definitions.characters[0].traits.feature, 'cold, elegant')
  assert.equal(ui.state.definitions.characters[1].traits.feature, 'gentle')
  assert.equal(ui.state.definitions.characters[0].name, '甲改名')
})

test('批量绑定卡片和启用状态按选择应用', async () => {
  const ui = harness()
  await ui.ready()
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.button('全选当前筛选').props.onClick(); ui.render()
  await ui.input('批量编辑字段').props.onChange({ target: { value: 'cards' } }); ui.render()
  const story = ui.nodes(ui.render()).find(node => node.type === 'label' && ui.text(node) === ' 故事卡')
  story.children[0].props.onChange({ target: { checked: true } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.input('批量编辑字段').props.onChange({ target: { value: 'enabled' } }); ui.render()
  ui.input('批量启用状态').props.onChange({ target: { value: 'false' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  for (const character of ui.state.definitions.characters) { assert.equal(character.enabled, false); assert.deepEqual(character.cards, ['cards/story.json']) }
})

test('后台刷新防止重复请求，保留人物与服装未保存草稿', async () => {
  let reads = 0
  const waiting = deferred()
  const ui = harness({ state: ({ state }) => ++reads === 1 ? copy(state) : waiting.promise })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '未保存' } }); ui.render()
  ui.button('新增套装').props.onClick(); ui.render()
  ui.intervals[0](); ui.intervals[0](); await flush()
  assert.equal(reads, 2)
  waiting.resolve(copy(ui.state)); await flush(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '未保存')
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.outfits.length, 1)
})

test('并发改进按稳定 id 合并最新内容；期间手改字段和改进草稿均保留', async () => {
  const waiting = { a: deferred(), b: deferred() }
  const ui = harness({ design: ({ body }) => waiting[body.current.id].promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '改甲' } }); ui.render()
  ui.roleInput('b', placeholder).props.onChange({ target: { value: '改乙' } }); ui.render()
  const aButton = ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const bButton = ui.nodes(ui.role('b')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const pendingA = aButton.props.onClick()
  const pendingB = bButton.props.onClick()
  waiting.b.resolve({ ok: true, people: [{ traits: { feature: 'bold' } }] }); await pendingB; ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '甲手改' } }); ui.render()
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '下一次改甲' } }); ui.render()
  waiting.a.resolve({ ok: true, people: [{ name: '甲生成', traits: { face: 'silver hair' } }] }); await pendingA; ui.render()
  assert.equal(ui.state.definitions.characters[0].name, '甲手改')
  assert.equal(ui.state.definitions.characters[0].traits.face, 'silver hair')
  assert.equal(ui.state.definitions.characters[1].traits.feature, 'bold')
  assert.equal(ui.roleInput('a', placeholder).props.value, '下一次改甲')
})

test('删掉前一位角色不会将改进结果或草稿移到错误角色；删掉目标时忽略结果', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('b', placeholder).props.onChange({ target: { value: '乙改发色' } }); ui.render()
  const pending = ui.nodes(ui.role('b')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进').props.onClick()
  ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '删除角色').props.onClick(); ui.render()
  assert.equal(ui.roleInput('b', placeholder).props.value, '乙改发色')
  waiting.resolve({ ok: true, people: [{ traits: { face: 'red hair' } }] }); await pending; ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.face]), [['b', 'red hair']])

  const deleted = deferred()
  const other = harness({ design: () => deleted.promise })
  await other.ready()
  other.roleInput('a', placeholder).props.onChange({ target: { value: '改甲' } }); other.render()
  const lost = other.nodes(other.role('a')).find(node => node.type === 'button' && other.text(node) === '✏️ 改进').props.onClick()
  other.nodes(other.role('a')).find(node => node.type === 'button' && other.text(node) === '删除角色').props.onClick(); other.render()
  deleted.resolve({ ok: true, people: [{ traits: { face: 'red hair' } }] }); await lost; other.render()
  assert.equal(other.requests.filter(request => request.path === 'definitions').length, 0)
  assert.equal(other.roleInput('b', '角色名').props.value, '乙')
})

test('照片识别绑定点击时的角色，后台返回不会覆盖期间的手改字段', async () => {
  const waiting = deferred()
  const ui = harness({ vision: () => waiting.promise })
  await ui.ready()
  ui.role('b')
  ui.button('从照片识别').props.onClick()
  ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '删除角色').props.onClick(); ui.render()
  ui.nodes(ui.role('b')).find(node => node.type === 'textarea' && node.props.value === 'black hair').props.onChange({ target: { value: '手动发色' } }); ui.render()
  waiting.resolve({ traits: { face: 'green hair', feature: 'bold' } }); await flush(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.face, character.traits.feature]), [['b', '手动发色', 'bold']])
})

test('保存等待期间的新修改不被响应覆盖；保存失败保留草稿且显示失败', async () => {
  const waiting = deferred()
  const ui = harness({ definitions: () => waiting.promise })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '第一次' } }); ui.render()
  const saving = ui.button('保存人物库').props.onClick(); await flush(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '第二次' } }); ui.render()
  const submitted = ui.requests.find(request => request.path === 'definitions').body.definitions
  waiting.resolve({ ok: true, state: { ...copy(ui.state), definitions: submitted } }); await saving; ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '第二次')
  assert.match(ui.text(ui.render()), /有未保存修改/)

  const failed = harness({ definitions: () => ({ ok: false, error: 'disk unavailable' }) })
  await failed.ready()
  failed.roleInput('a', '角色名').props.onChange({ target: { value: '草稿' } }); failed.render()
  assert.equal(await failed.button('保存人物库').props.onClick(), false)
  failed.render()
  assert.equal(failed.roleInput('a', '角色名').props.value, '草稿')
  assert.match(failed.text(failed.render()), /保存失败/)
})

test('新建设计面板防重复提交，回包追加到最新人物库，保留下一份需求草稿', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  await ui.button('让 agent 设计角色').props.onClick(); ui.render()
  ui.input('搜索角色').props.onChange({ target: { value: '乙' } }); ui.render()
  const prompt = '例如：生成一个穿着古风汉服的少女角色，温柔可爱…'
  ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.onChange({ target: { value: '新角色一' } }); ui.render()
  const submit = ui.button('确定生成').props.onClick
  const pending = submit()
  await submit()
  ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'design').length, 1)
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙手改' } }); ui.render()
  ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.onChange({ target: { value: '新角色二' } }); ui.render()
  waiting.resolve({ ok: true, people: [{ name: '生成角色', traits: { face: 'silver hair' } }] }); await pending; ui.render()
  assert.equal(ui.input('搜索角色').props.value, '')
  const generatedId = ui.state.definitions.characters[2].id
  assert.equal(ui.input('当前角色').props.value, generatedId)
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), [generatedId])
  assert.equal(ui.state.definitions.characters.length, 3)
  assert.equal(ui.state.definitions.characters[1].name, '乙手改')
  assert.equal(ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.value, '新角色二')
  assert.match(ui.text(ui.render()), /已生成 1 位角色并保存/)
})

test('保存串行排队读取最新草稿，过期后台刷新不会撤销已保存修改', async () => {
  const pendingRefresh = deferred()
  const firstSave = deferred()
  let reads = 0
  let saves = 0
  const ui = harness({
    state: ({ state }) => ++reads === 1 ? copy(state) : pendingRefresh.promise,
    definitions: ({ body, state, setState }) => {
      saves += 1
      const next = { ...state, definitions: copy(body.definitions) }
      if (saves === 1) return firstSave.promise.then(() => { setState(next); return { ok: true, state: copy(next) } })
      setState(next)
      return { ok: true, state: copy(next) }
    },
  })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '保存前' } }); ui.render()
  ui.intervals[0](); await flush()
  const staleState = copy(ui.state)
  const first = ui.button('保存人物库').props.onClick(); await flush(); ui.render()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '排队新修改' } }); ui.render()
  const second = ui.button('保存人物库').props.onClick(); await flush()
  assert.equal(saves, 1)
  firstSave.resolve(); await Promise.all([first, second]); ui.render()
  assert.equal(saves, 2)
  pendingRefresh.resolve(staleState); await flush(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '保存前')
  assert.equal(ui.roleInput('b', '角色名').props.value, '排队新修改')
})

test('搜索按角色名和英文触发名过滤；无匹配空态不删除角色', async () => {
  const chars = [person('a', '甲主角'), Object.assign(person('b', '乙主角'), { match: 'yiren' }), person('c', '丙配角')]
  const ui = harness({}, chars)
  await ui.ready()
  const original = copy(ui.state.definitions.characters)
  const search = ui.input('搜索角色')

  search.props.onChange({ target: { value: '乙主' } }); ui.render()
  let selector = ui.input('当前角色')
  assert.deepEqual(selector.children.map(option => option.props.value), ['b'])
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  ui.input('搜索角色').props.onChange({ target: { value: 'yiren' } }); ui.render()
  selector = ui.input('当前角色')
  assert.deepEqual(selector.children.map(option => option.props.value), ['b'])
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  ui.input('搜索角色').props.onChange({ target: { value: '不存在' } }); ui.render()
  assert.equal(ui.rolePanels().length, 0)
  assert.match(ui.text(ui.render()), /没有匹配的角色/)
  assert.deepEqual(ui.state.definitions.characters, original)
})

test('删除当前角色后切换到可用角色；新增角色后自动选中新增项', async () => {
  const removed = harness()
  await removed.ready()
  removed.nodes(removed.role('a')).find(node => node.type === 'button' && removed.text(node) === '删除角色').props.onClick()
  removed.render()
  assert.equal(removed.input('当前角色').props.value, 'b')
  assert.deepEqual(removed.rolePanels().map(panel => panel.props.key), ['b'])
  assert.equal(removed.roleInput('b', '角色名').props.value, '乙')

  const added = harness()
  await added.ready()
  added.input('搜索角色').props.onChange({ target: { value: '乙' } }); added.render()
  added.button('新增角色').props.onClick(); added.render()
  assert.equal(added.input('搜索角色').props.value, '')
  await added.button('保存人物库').props.onClick(); added.render()
  const characters = added.state.definitions.characters
  const created = characters.at(-1)
  assert.equal(added.input('当前角色').props.value, created.id)
  assert.deepEqual(added.rolePanels().map(panel => panel.props.key), [created.id])
  assert.equal(added.roleInput(created.id, '角色名').props.value, '')
})

test('过滤后全选只勾当前可见角色，隐藏的已选角色仍参与批量更改', async () => {
  const ui = harness({}, [person('a', '甲'), person('b', '乙'), person('c', '丙')])
  await ui.ready()
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.input('批量选择角色 丙').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('搜索角色').props.onChange({ target: { value: '甲' } }); ui.render()
  ui.button('全选当前筛选').props.onClick(); ui.render()
  assert.equal(ui.input('批量选择角色 甲').props.checked, true)

  ui.input('搜索角色').props.onChange({ target: { value: '' } }); ui.render()
  assert.equal(ui.input('批量选择角色 甲').props.checked, true)
  assert.equal(ui.input('批量选择角色 乙').props.checked, false)
  assert.equal(ui.input('批量选择角色 丙').props.checked, true)
  assert.match(ui.text(ui.render()), /已选 2 \/ 3 位/)

  await ui.input('批量编辑字段').props.onChange({ target: { value: 'feature' } }); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: '仅作用于选中项' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.feature]), [
    ['a', '仅作用于选中项'], ['b', 'gentle'], ['c', '仅作用于选中项'],
  ])
})

test('初始角色改名改变排序后仍保留同一当前角色', async () => {
  const ui = harness()
  await ui.ready()
  assert.equal(ui.input('当前角色').props.value, 'a')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['a'])

  const name = ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '角色名')
  name.props.onChange({ target: { value: '龟' } }); ui.render()
  assert.equal(ui.input('当前角色').props.value, 'a')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['a'])
  assert.equal(ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '角色名').props.value, '龟')
})

test('通过英文触发名筛选后修改触发名会清空筛选并保留当前角色', async () => {
  const ui = harness({}, [person('a', '甲'), Object.assign(person('b', '乙'), { match: 'yiren' })])
  await ui.ready()
  ui.input('搜索角色').props.onChange({ target: { value: 'yiren' } }); ui.render()
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  const match = ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '英文名（逗号分隔，用来触发）')
  match.props.onChange({ target: { value: 'newname' } }); ui.render()
  assert.equal(ui.input('搜索角色').props.value, '')
  assert.equal(ui.input('当前角色').props.value, 'b')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])
  assert.equal(ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '英文名（逗号分隔，用来触发）').props.value, 'newname')
})

test('切换当前角色后异步改进仍合并到发起时的稳定 id', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '改甲发色' } }); ui.render()
  const improve = ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const pending = improve.props.onClick()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙手改' } }); ui.render()
  waiting.resolve({ ok: true, people: [{ traits: { face: 'silver hair' } }] }); await pending; ui.render()
  assert.equal(ui.input('当前角色').props.value, 'b')
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.name, character.traits.face]), [
    ['a', '甲', 'silver hair'], ['b', '乙手改', 'black hair'],
  ])
})

test('复制当前角色生成唯一角色与服装 id，保留绑定并允许副本独立编辑', async () => {
  const original = Object.assign(person('a', '甲'), {
    cards: ['cards/story.json'], outfitRefs: ['global-1'],
    outfits: [{ id: 'outfit-a', name: '原套装', upper: '白衬衫', lower: '长裙', enabled: true, default: true }],
  })
  const ui = harness({}, [original])
  await ui.ready()
  ui.input('搜索角色').props.onChange({ target: { value: '甲' } }); ui.render()
  ui.button('复制当前角色').props.onClick(); ui.render()

  assert.equal(ui.input('搜索角色').props.value, '')
  assert.equal(ui.input('当前角色').props.value === 'a', false)
  assert.match(ui.text(ui.render()), /有未保存修改/)
  await ui.button('保存人物库').props.onClick(); ui.render()
  const [source, duplicate] = ui.state.definitions.characters
  assert.equal(duplicate.name, '甲（副本）')
  assert.notEqual(duplicate.id, source.id)
  assert.notEqual(duplicate.outfits[0].id, source.outfits[0].id)
  assert.deepEqual(duplicate.cards, source.cards)
  assert.deepEqual(duplicate.outfitRefs, source.outfitRefs)
  assert.deepEqual(duplicate.traits, source.traits)
  assert.equal(ui.input('当前角色').props.value, duplicate.id)

  const panel = ui.role(duplicate.id)
  ui.nodes(panel).find(node => node.type === 'textarea' && node.props.value === 'gentle').props.onChange({ target: { value: '副本特征' } }); ui.render()
  ui.roleInput(duplicate.id, '服装名（常服 / 居家 / 内衣…）').props.onChange({ target: { value: '副本套装' } }); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.definitions.characters[0].traits.feature, 'gentle')
  assert.equal(ui.state.definitions.characters[0].outfits[0].name, '原套装')
  assert.equal(ui.state.definitions.characters[1].traits.feature, '副本特征')
  assert.equal(ui.state.definitions.characters[1].outfits[0].name, '副本套装')
})

test('插件更新检查与安装分离，重复点击合并请求，成功后提示重启并禁止再次安装', async () => {
  const checking = deferred()
  const installing = deferred()
  let checkCalls = 0
  let applyCalls = 0
  const ui = harness({
    state: ({ state, setState }) => {
      const next = Object.assign({}, state, { config: { apiToken: 'secret-must-not-be-sent' } })
      setState(next)
      return copy(next)
    },
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: ({ body }) => { checkCalls++; return checking.promise },
    apply: ({ body }) => { applyCalls++; return installing.promise },
  })
  await ui.openPluginUpdate()
  const stateReads = ui.requests.filter(request => request.path === 'state').length
  assert.ok(ui.requests.some(request => request.pathname === '/plugins/dsh-tavern-image/plugin-update' && request.method === 'GET'))

  const check = ui.button('检查更新').props.onClick
  const firstCheck = check()
  const duplicateCheck = check()
  await flush()
  assert.equal(checkCalls, 1)
  assert.equal(applyCalls, 0)
  checking.resolve({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' })
  await Promise.all([firstCheck, duplicateCheck]); await flush(); ui.render()
  const checkRequest = ui.requests.find(request => request.pathname === '/plugins/dsh-tavern-image/plugin-update/check')
  assert.equal(checkRequest.method, 'POST')
  assert.deepEqual(checkRequest.body, {})
  assert.match(ui.text(ui.render()), /1\.3\.0/)
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)

  const apply = ui.button('更新插件').props.onClick
  const firstApply = apply()
  const duplicateApply = apply()
  await flush()
  assert.equal(applyCalls, 1)
  const applyRequest = ui.requests.find(request => request.pathname === '/plugins/dsh-tavern-image/plugin-update/apply')
  assert.equal(applyRequest.method, 'POST')
  assert.deepEqual(applyRequest.body, { target: 'v1.3.0' })
  installing.resolve({ ok: true, currentVersion: '1.3.0', latestVersion: '1.3.0', available: false, canUpdate: false, restartRequired: true, message: '插件更新完成，请完整重启 DSH 后生效。' })
  await Promise.all([firstApply, duplicateApply]); await flush(); ui.render()
  assert.match(ui.text(ui.render()), /完整重启 DSH/)
  const updateButton = ui.nodes(ui.render()).find(node => node.type === 'button' && ui.text(node) === '更新插件')
  assert.ok(!updateButton || updateButton.props.disabled)
  assert.equal(applyCalls, 1)
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)
})

test('旧目录安装在插件更新页持续显示退出 DSH 后手动迁移提示', async () => {
  const migrationMessage = '旧版安装仍在 dsh-tavern-comfy 目录。请先完全退出 DSH，再将该文件夹改名为 dsh-tavern-image，然后重新启动。'
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '2.1.0', supported: true, directoryMigrationRequired: true, directoryMigrationMessage: migrationMessage }),
  })
  await ui.openPluginUpdate()
  assert.match(ui.text(ui.render()), /完全退出 DSH/)
  assert.match(ui.text(ui.render()), /dsh-tavern-comfy/)
  assert.match(ui.text(ui.render()), /dsh-tavern-image/)
})

test('旧目录旁已有新目录时显示冲突原因，不提示用户直接改名', async () => {
  const ui = harness({
    'plugin-update': () => ({
      ok: true,
      currentVersion: '2.1.0',
      supported: false,
      directoryMigrationRequired: true,
      directoryMigrationMessage: '请退出 DSH 后改目录。',
      reason: '新插件目录已存在。请先备份并处理两个目录。',
    }),
  })
  await ui.openPluginUpdate()
  const rendered = ui.text(ui.render())
  assert.match(rendered, /新插件目录已存在/)
  assert.doesNotMatch(rendered, /请退出 DSH 后改目录/)
})

test('插件更新检查失败后可重试', async () => {
  let checkCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ++checkCalls === 1
      ? ({ ok: false, error: 'temporary update lookup failure' })
      : ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  assert.match(ui.text(ui.render()), /检查更新失败/)
  assert.equal(checkCalls, 1)

  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  assert.equal(checkCalls, 2)
  assert.equal(ui.button('更新插件').props.disabled, false)
  assert.equal(ui.requests.filter(request => request.pathname === '/plugins/dsh-tavern-image/plugin-update/apply').length, 0)
})

test('人物草稿未保存时阻止插件安装并保留草稿', async () => {
  let applyCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
    apply: () => { applyCalls++; return { ok: true, currentVersion: '1.3.0', restartRequired: true } },
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()

  ui.button('人物库').props.onClick(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '未保存角色名' } }); ui.render()
  ui.button('插件更新').props.onClick(); ui.render()
  ui.button('更新插件').props.onClick(); ui.render()
  assert.equal(applyCalls, 0)
  assert.match(ui.text(ui.render()), /先保存人物库/)

  ui.button('人物库').props.onClick(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '未保存角色名')
  assert.equal(ui.requests.filter(request => request.pathname === '/plugins/dsh-tavern-image/plugin-update/apply').length, 0)
})

test('更新请求跨页成功后保留重启状态并保留人物页新草稿', async () => {
  const installing = deferred()
  let applyCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
    apply: () => { applyCalls++; return installing.promise },
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  const stateReads = ui.requests.filter(request => request.path === 'state').length
  const pending = ui.button('更新插件').props.onClick()
  await flush()
  assert.equal(applyCalls, 1)

  ui.button('人物库').props.onClick(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '跨页期间的草稿' } }); ui.render()
  installing.resolve({ ok: true, currentVersion: '1.3.0', available: false, canUpdate: false, restartRequired: true, message: '插件文件已更新。' })
  await pending; await flush(); ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)

  ui.button('插件更新').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /完整重启 DSH/)
  const updateButton = ui.nodes(ui.render()).find(node => node.type === 'button' && ui.text(node) === '更新插件')
  assert.ok(!updateButton || updateButton.props.disabled)
  assert.equal(applyCalls, 1)

  ui.button('人物库').props.onClick(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '跨页期间的草稿')
})

test('设置里保存正文图片显示宽度：输入过程不发请求，保存后立刻反馈，可恢复默认', async () => {
  const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await flush() }
  const ui = harness({
    config: ({ body, state, setState }) => {
      const next = { ...state, config: { ...state.config, ...body.config } }
      setState(next)
      return { ok: true, state: copy(next) }
    },
  })
  ui.render(); await flush(); ui.render()

  const widthInput = () => ui.input('正文图片显示宽度（像素）')
  assert.equal(widthInput().props.value, '', '没设置过时输入框留空，表示默认')
  assert.equal(ui.input('正文图片显示宽度').props.value, '660', '默认时滑块停在正文原本的显示宽度上')
  assert.equal(ui.button('保存').props.disabled, true, '没有改动就不该能保存')

  // 边输边发请求就是 bug：输入过程只改草稿。
  for (const value of ['9', '90', '900']) { widthInput().props.onChange({ target: { value } }); ui.render() }
  assert.equal(widthInput().props.value, '900')
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.requests.filter(request => request.path === 'config').length, 0)

  // 非数字直接挡住，不把 NaN 发到服务端。
  widthInput().props.onChange({ target: { value: '90px' } }); ui.render()
  assert.equal(ui.button('保存').props.disabled, true)
  assert.match(ui.text(ui.render()), /宽度只能是数字/)
  widthInput().props.onChange({ target: { value: '900' } }); ui.render()

  await ui.button('保存').props.onClick()
  await settle(); ui.render()
  const saves = ui.requests.filter(request => request.path === 'config')
  assert.equal(saves.length, 1, '一次保存只发一个请求')
  assert.deepEqual(saves[0].body, { config: { imageDisplayWidth: 900 } })
  assert.match(ui.text(ui.render()), /已保存：正文插图统一按 900 px 显示/)

  // 超出范围的输入在前端就收窄到 160–2000，绝不让正文被撑爆。
  widthInput().props.onChange({ target: { value: '99999' } }); ui.render()
  assert.match(ui.text(ui.render()), /2000 px/)
  await ui.button('保存').props.onClick()
  await settle(); ui.render()
  assert.deepEqual(ui.requests.filter(request => request.path === 'config').at(-1).body, { config: { imageDisplayWidth: 2000 } })

  // 恢复默认 = 回到 0，也就是现有显示效果。
  await ui.button('恢复默认').props.onClick()
  await settle(); ui.render()
  const requests = ui.requests.filter(request => request.path === 'config')
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.at(-1).body, { config: { imageDisplayWidth: 0 } })
  assert.match(ui.text(ui.render()), /已恢复默认大小/)
  assert.equal(ui.button('恢复默认').props.disabled, true, '已经是默认了就不必再恢复')
})

test('刷新后正文插图仍按保存的全局宽度显示：启动读一次 /state，渲染插图不再发请求', async () => {
  // 模拟"上次保存过 900，这次刷新页面"：/state 里带着保存过的值。
  const savedState = ({ state }) => ({ ...copy(state), config: { ...state.config, imageDisplayWidth: 900 } })

  const officialUi = harness({ state: savedState })
  officialUi.api.apply({})
  await flush(); await flush()
  const reads = officialUi.requests.filter(request => request.path === 'state').length
  assert.equal(reads, 1, '启动时只读一次 /state')

  // 正文里已经存在的图（历史媒体）也要用新的全局宽度。
  const official = officialUi.renderComponent(officialUi.api.__test.OfficialImage, {
    gameId: 'game-boot', turn: 3,
    item: { id: 'media-boot', textVersion: 'text-v3', status: 'ready', url: '/old.png', data: { jobId: 'job-old' } },
  })
  const officialImg = officialUi.nodes(official).find(node => node.type === 'img')
  assert.equal(officialImg.props.style.width, '900px', '宽度给足，最终像素值由 useForcedImageWidth 用 !important 落到元素上')
  assert.equal(officialImg.props.style.maxWidth, '96vw', '样式里的兜底上限，实际像素由 !important 强制')
  assert.equal(officialImg.props.style.height, 'auto', '高度仍按原比例，只改显示宽度')
  assert.equal(officialUi.requests.filter(request => request.path === 'state').length, reads, '正文渲染热路径里不允许有 /state 请求')

  // 正文标记生成的新图走另一条渲染路径，必须共用同一个宽度。
  const inlineUi = harness({ state: savedState, jobs: () => ({ ok: true, job: { id: 'inline-boot-job', status: 'done' } }) })
  inlineUi.api.apply({})
  await flush(); await flush()
  inlineUi.renderComponent(inlineUi.api.__test.InlineImage, { prompt: 'portrait', imageKey: 'boot-key', auto: true })
  await flush(); await flush()
  const inline = inlineUi.renderComponent(inlineUi.api.__test.InlineImage, { prompt: 'portrait', imageKey: 'boot-key', auto: true })
  const inlineImg = inlineUi.nodes(inline).find(node => node.type === 'img')
  assert.ok(inlineImg, '恢复出来的正文插图应该渲染成图片')
  assert.equal(inlineImg.props.style.width, '900px')
  assert.equal(inlineImg.props.style.maxWidth, '96vw')
})

test('检查结果标记不支持时显示原因且不误报已是最新', async () => {
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', available: false, supported: false, reason: '源不支持' }),
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  const status = ui.nodes(ui.render()).find(node => node.props.role === 'status' && node.props['aria-live'] === 'polite')
  assert.ok(status)
  assert.match(ui.text(status), /源不支持/)
  assert.doesNotMatch(ui.text(ui.render()), /当前已是最新版本/)
  assert.equal(ui.button('更新插件').props.disabled, true)
})
test('Release updater remains visible when Git support is false and shows live Tavern incompatibility', async () => {
  const ui = harness({
    'plugin-update': () => ({
      ok: true, mode: 'release', supported: false,
      compatibility: {
        compatible: false, requiredApiVersion: 1, hostApiVersion: null,
        reason: '此插件要求 Tavern 插件 API v1 或更新版本；当前宿主 API 未知。请先更新 Tavern，再更新插件。',
      },
    }),
  })
  await ui.openPluginUpdate()
  const rendered = ui.text(ui.render())
  assert.match(rendered, /Release 更新：下载官方发布包并校验 SHA-256/)
  assert.match(rendered, /先更新 Tavern/)
  assert.equal(ui.button('检查更新').props.disabled, true)
})

test('从其他角色复制服装：可多选、同名加（复制）、新编号且不抢常穿，保存后各自独立', async () => {
  const a = Object.assign(person('a', '甲'), { outfits: [
    { id: 'a1', name: '常服', upper: '白衬衫', lower: '长裙', enabled: true, default: true },
    { id: 'a2', name: '睡衣', upper: '吊带', lower: '短裤', enabled: true, default: false },
    { id: 'a3', name: '礼服', upper: '黑色礼服', lower: '', enabled: false, default: false },
  ] })
  const b = Object.assign(person('b', '乙'), { outfits: [{ id: 'b1', name: '常服', upper: '卫衣', lower: '牛仔裤', enabled: true, default: true }] })
  const ui = harness({}, [a, b])
  await ui.ready()
  ui.role('b')
  ui.button('从其他角色复制服装').props.onClick(); ui.render()
  ui.input('复制服装的来源角色').props.onChange({ target: { value: 'a' } }); ui.render()
  assert.equal(ui.button('先勾选要复制的服装').props.disabled, true)
  const box = name => ui.nodes(ui.input('复制服装')).find(node => node.type === 'label' && ui.text(node).startsWith(name)).children.find(child => child.type === 'input')
  box('常服').props.onChange({ target: { checked: true } }); ui.render()
  box('礼服').props.onChange({ target: { checked: true } }); ui.render()
  ui.button('复制这 2 套到「乙」').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /有未保存修改/)
  await ui.button('保存人物库').props.onClick(); ui.render()
  const [savedA, savedB] = ui.state.definitions.characters
  assert.deepEqual(savedB.outfits.map(o => o.name), ['常服', '常服（复制）', '礼服'])
  assert.deepEqual(savedB.outfits.map(o => o.default), [true, false, false])
  assert.equal(savedB.outfits[1].upper, '白衬衫')
  assert.equal(savedB.outfits[2].enabled, false)
  const ids = savedB.outfits.map(o => o.id)
  assert.equal(new Set(ids.concat(savedA.outfits.map(o => o.id))).size, 6)
  assert.equal(savedA.outfits.length, 3)
  // 面板复制完自动收起
  assert.equal(ui.nodes(ui.render()).some(node => node.props?.['aria-label'] === '复制服装'), false)
})

test('复制服装：目标角色没有服装时，第一套复制品成为常穿', async () => {
  const a = Object.assign(person('a', '甲'), { outfits: [{ id: 'a1', name: '常服', upper: '白衬衫', enabled: true, default: true }] })
  const ui = harness({}, [a, person('b', '乙')])
  await ui.ready()
  ui.role('b')
  ui.button('从其他角色复制服装').props.onClick(); ui.render()
  ui.input('复制服装的来源角色').props.onChange({ target: { value: 'a' } }); ui.render()
  ui.button('全选').props.onClick(); ui.render()
  ui.button('复制这 1 套到「乙」').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  const savedB = ui.state.definitions.characters[1]
  assert.equal(savedB.outfits.length, 1)
  assert.equal(savedB.outfits[0].default, true)
  assert.notEqual(savedB.outfits[0].id, 'a1')
})

test('按部位复制：从几套里挑部位拼成新服装，同一部位按顺序用逗号拼接', async () => {
  const a = Object.assign(person('a', '甲'), { outfits: [
    { id: 'a1', name: '常服', upper: '白衬衫', lower: '长裙', shoes: '帆布鞋', accessory: '', enabled: true, default: true },
    { id: 'a2', name: '冬装', upper: '大衣', lower: '毛呢裙', shoes: '短靴', accessory: '围巾', enabled: true, default: false },
  ] })
  const b = Object.assign(person('b', '乙'), { outfits: [{ id: 'b1', name: '常服', upper: '卫衣', lower: '牛仔裤', enabled: true, default: true }] })
  const ui = harness({}, [a, b])
  await ui.ready()
  ui.role('b')
  ui.button('从其他角色复制服装').props.onClick(); ui.render()
  ui.input('复制服装的来源角色').props.onChange({ target: { value: 'a' } }); ui.render()
  ui.button('按部位复制').props.onClick(); ui.render()
  assert.equal(ui.button('先勾选要复制的部位').props.disabled, true)
  ui.input('常服-上衣').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('冬装-上衣').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('冬装-配饰').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('新服装名').props.onChange({ target: { value: '常服' } }); ui.render()
  ui.button('复制 2 个部位为新服装').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  const savedB = ui.state.definitions.characters[1]
  assert.equal(savedB.outfits.length, 2)
  const made = savedB.outfits[1]
  assert.equal(made.name, '常服（复制）')
  assert.equal(made.upper, '白衬衫, 大衣')
  assert.equal(made.accessory, '围巾')
  assert.equal(made.lower, '')
  assert.equal(made.default, false)
  assert.equal(ui.state.definitions.characters[0].outfits[1].upper, '大衣')
})

test('按部位复制：放进已有的一套，可覆盖或追加；整套勾选会勾上有内容的全部部位', async () => {
  const a = Object.assign(person('a', '甲'), { outfits: [{ id: 'a1', name: '泳装', upper: '白色比基尼', lower: '比基尼下装', shoes: '凉鞋', accessory: '草帽', enabled: true, default: true }] })
  const b = Object.assign(person('b', '乙'), { outfits: [{ id: 'b1', name: '度假', upper: '吊带', lower: '短裙', shoes: '', accessory: '墨镜', enabled: true, default: true }] })
  const ui = harness({}, [a, b])
  await ui.ready()
  ui.role('b')
  ui.button('从其他角色复制服装').props.onClick(); ui.render()
  ui.input('复制服装的来源角色').props.onChange({ target: { value: 'a' } }); ui.render()
  ui.button('按部位复制').props.onClick(); ui.render()
  ui.input('整套部位-泳装').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('泳装-上衣').props.onChange({ target: { checked: false } }); ui.render()
  ui.input('部位复制的目标服装').props.onChange({ target: { value: 'b1' } }); ui.render()
  ui.input('部位合并方式').props.onChange({ target: { value: 'append' } }); ui.render()
  ui.button('复制 3 个部位到这套').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  const outfit = ui.state.definitions.characters[1].outfits[0]
  assert.equal(ui.state.definitions.characters[1].outfits.length, 1)
  assert.equal(outfit.upper, '吊带')
  assert.equal(outfit.lower, '短裙, 比基尼下装')
  assert.equal(outfit.shoes, '凉鞋')
  assert.equal(outfit.accessory, '墨镜, 草帽')
  assert.equal(outfit.id, 'b1')

  ui.button('从其他角色复制服装').props.onClick(); ui.render()
  ui.input('复制服装的来源角色').props.onChange({ target: { value: 'a' } }); ui.render()
  ui.button('按部位复制').props.onClick(); ui.render()
  ui.input('泳装-配饰').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('部位复制的目标服装').props.onChange({ target: { value: 'b1' } }); ui.render()
  ui.button('复制 1 个部位到这套').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.definitions.characters[1].outfits[0].accessory, '草帽')
})
