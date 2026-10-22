import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWeightMode, compileChannelJob } from '../lib/index.js'

test('权重写法按渠道自动选择：NovelAI 原样，其它渠道照旧转换', () => {
  assert.equal(resolveWeightMode({ weightMode: 'convert' }, 'novelai', 'tags'), 'keep')
  assert.equal(resolveWeightMode({ weightMode: 'auto' }, 'novelai', 'tags'), 'keep')
  assert.equal(resolveWeightMode({ weightMode: 'convert' }, 'comfyui', 'tags'), 'convert')
  assert.equal(resolveWeightMode({ weightMode: 'keep' }, 'comfyui', 'tags'), 'keep')
  assert.equal(resolveWeightMode({ weightMode: 'convert' }, 'openai', 'natural'), 'strip')
  assert.equal(resolveWeightMode({ weightMode: 'keep' }, 'novelai', 'natural'), 'strip')
})

test('NovelAI 不再把画风里的多 Tag 权重组转成 Comfy 括号', () => {
  const params = {
    tag: '15::best quality,ultra-detailed::, 1.2::artist: takeda hiromitsu::, (blue coat:1.2)',
    rawTag: '15::best quality,ultra-detailed::, 1.2::artist: takeda hiromitsu::, (blue coat:1.2)',
    artist: '', negative: '', size: '竖图',
  }
  const config = { imageBackend: 'novelai', promptMode: 'tags', weightMode: 'convert', sizes: { 竖图: { width: 512, height: 768 } } }
  const compiled = compileChannelJob({ params, config, definitions: {} })
  // 原样保留多 Tag 权重组；单 Tag 的 Comfy 括号仍按 NAI 语法转换。
  assert.match(compiled.positive, /15::best quality, ultra-detailed::/)
  assert.match(compiled.positive, /1\.2::artist: takeda hiromitsu::/)
  assert.match(compiled.positive, /1\.2::blue coat::/)
  assert.doesNotMatch(compiled.positive, /:2\)/)
})
