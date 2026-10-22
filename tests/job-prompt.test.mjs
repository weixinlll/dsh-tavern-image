import test from 'node:test'
import assert from 'node:assert/strict'
import { formatJobPrompt } from '../lib/planner.js'

test('NovelAI 分角色作业的编辑器文本包含场景和全部角色块', () => {
  const job = {
    backend: 'novelai',
    params: {
      rawTag: '1girl, 1boy, indoors, café',
      characters: [
        { prompt: 'lin lan, white shirt', centers: 'C3', uc: 'background characters' },
        { prompt: 'alan, black coat', centers: 'D4', uc: 'background characters, fused bodies' },
      ],
    },
    positive: 'artist, 1girl, 1boy, indoors, café',
  }
  const text = formatJobPrompt(job)
  assert.match(text, /^<scene_composition>1girl, 1boy, indoors, café<\/scene_composition>/)
  assert.match(text, /<character_1>[\s\S]*<prompt>lin lan, white shirt<\/prompt>[\s\S]*<centers>C3<\/centers>[\s\S]*<uc>background characters<\/uc>[\s\S]*<\/character_1>/)
  assert.match(text, /<character_2>[\s\S]*<prompt>alan, black coat<\/prompt>[\s\S]*<centers>D4<\/centers>/)
  assert.equal((text.match(/<scene_composition>/g) || []).length, 1)
})

test('rawTag 已经是完整结构时不会重复包一层场景', () => {
  const job = {
    backend: 'novelai',
    params: {
      rawTag: '<prompts><scene_composition>1girl, indoors</scene_composition><character_1><prompt>lin lan</prompt><centers>C3</centers></character_1></prompts>',
      characters: [{ prompt: 'lin lan', centers: 'C3', uc: '' }],
    },
    positive: 'artist, 1girl, indoors',
  }
  const text = formatJobPrompt(job)
  assert.equal((text.match(/<scene_composition>/g) || []).length, 1)
  assert.match(text, /<scene_composition>1girl, indoors<\/scene_composition>/)
  assert.match(text, /<character_1>[\s\S]*<prompt>lin lan<\/prompt>/)
})

test('非 NovelAI 渠道保持原来的单条提示词', () => {
  const job = {
    backend: 'comfyui',
    params: {
      rawTag: '1girl, indoors',
      characters: [{ prompt: 'lin lan', centers: 'C3', uc: 'background characters' }],
    },
    positive: 'artist, 1girl, indoors',
  }
  assert.equal(formatJobPrompt(job), '1girl, indoors')
  assert.doesNotMatch(formatJobPrompt(job), /<character_|<scene_composition>/)
})

test('NovelAI 没有角色块时保持单条提示词', () => {
  const job = { backend: 'novelai', params: { rawTag: '1girl, no humans' }, positive: 'artist, 1girl' }
  assert.equal(formatJobPrompt(job), '1girl, no humans')
})
