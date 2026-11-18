import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationControl, SpeechEchoFilter } from '../src/shared/conversation.ts'
import { ResponseGate } from '../src/main/response-gate.ts'
import { buildSystemExtra } from '../src/main/agent-prompt.ts'

const aliases = ['джарвис', 'jarvis', 'джарви']

test('spoken conversation activation accepts the name at either end and preserves the topic', () => {
  for (const phrase of ['Джарвис, давай пообщаемся', 'Давай пообщаемся, Джарвис', 'Джарвис, давай поговорим', "Jarvis, let's chat"]) {
    assert.deepEqual(conversationControl(phrase, aliases), { action: 'start', topic: '' }, phrase)
  }
  assert.deepEqual(conversationControl('Джарвис, давай поговорим про USB Микрофон', aliases), { action: 'start', topic: 'USB Микрофон' })
  assert.deepEqual(conversationControl('Давай поговорим про USB Микрофон, Джарвис', aliases), { action: 'start', topic: 'USB Микрофон' })
  assert.deepEqual(conversationControl('Альфред, давай пообщаемся', ['альфред']), { action: 'start', topic: '' })
})

test('whole exit phrases work without treating discussion or quoted examples as controls', () => {
  for (const text of ['Джарвис, закончим разговор', 'закончим разговор', 'хватит общаться', 'вернись в режим ожидания']) {
    assert.deepEqual(conversationControl(text, aliases), { action: 'end' }, text)
  }
  for (const text of ['Что значит давай пообщаемся', 'Напиши «Джарвис, давай пообщаемся»', 'Объясни как закончить разговор', 'закончим разговор про настройки завтра']) {
    assert.equal(conversationControl(text, aliases), null, text)
  }
})

test('echo filtering rejects a recent long answer while preserving short replies and corrections', () => {
  const filter = new SpeechEchoFilter()
  filter.remember('Открой настройки звука и выбери нужный микрофон', 1000)
  assert.equal(filter.matches('открой настройки звука и выбери нужный микрофон', 1100), true)
  for (const text of ['да', 'нет', 'микрофон', 'подожди я говорю про другой микрофон', 'Джарвис закончим разговор']) assert.equal(filter.matches(text, 1100), false)
  filter.ended(1200)
  assert.equal(filter.matches('открой настройки звука и выбери нужный микрофон', 4201), false)
})

test('a short echoed greeting is discarded without consuming a one-word user reply', () => {
  const filter = new SpeechEchoFilter()
  filter.remember('Я слушаю, сэр. О чём поговорим?', 1000)
  assert.equal(filter.matches('Я слушаю', 1100), true)
  assert.equal(filter.matches('да', 1100), false)
})

test('late model parts and assistant messages remain blocked after a new turn starts', () => {
  const gate = new ResponseGate()
  gate.begin()
  gate.message({ id: 'user-old', role: 'user' })
  assert.equal(gate.message({ id: 'old-a', role: 'assistant', parentID: 'user-old' }), true)
  gate.pause()
  assert.equal(gate.part('old-a'), false)
  gate.begin()
  assert.equal(gate.message({ id: 'old-b', role: 'assistant', parentID: 'user-old' }), false)
  gate.message({ id: 'user-new', role: 'user' })
  assert.equal(gate.message({ id: 'new-a', role: 'assistant', parentID: 'user-new' }), true)
  assert.equal(gate.part('new-a'), true)
  assert.equal(gate.part('old-a'), false)
  assert.equal(gate.hasOutput, true)
})

test('live prompt distinguishes conversation, interruptions, heard speech and completed actions', () => {
  const text = buildSystemExtra({ memory: '', routines: [], lang: 'Russian', via: 'voice', screen: '1920x1080', vision: false, time: '', custom: '', conversation: true, interruption: 'Fully played sentences: hello\nCompleted tool steps: opened settings' })
  assert.match(text, /Live conversation/)
  assert.match(text, /hypothetical/)
  assert.match(text, /Fully played sentences: hello/)
  assert.match(text, /Completed tool steps: opened settings/)
})

test('changing sessions clears the active parent while keeping older responses blocked', () => {
  const gate = new ResponseGate()
  gate.begin()
  gate.message({ id: 'old-user', role: 'user' })
  gate.reset()
  assert.equal(gate.hasParent, false)
  gate.begin()
  assert.equal(gate.message({ id: 'late', role: 'assistant', parentID: 'old-user' }), false)
  assert.equal(gate.message({ id: 'new', role: 'assistant', parentID: 'new-user' }), true)
})
