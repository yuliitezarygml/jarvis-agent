import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confidentRussian } from '../src/main/speech/language.ts'

test('clear Russian invitations and commands survive a wrong multilingual language guess', () => {
  for (const text of ['Джарис, давай пообщаемся.', 'Давай пообщаемся', 'Как у тебя дела?', 'Открой папку', 'Расскажи, какая сегодня погода']) {
    assert.equal(confidentRussian(text), true, text)
  }
})

test('foreign speech and its Cyrillic transliteration still require multilingual identification', () => {
  for (const text of ['Jarvis, hello please open chrome', 'Bună ziua, hai să vorbim', 'хай са ворбим', 'хеллоу джарвис', 'Джарвис', 'Да', 'Окей', 'как как', 'открой Chrome browser settings please']) {
    assert.equal(confidentRussian(text), false, text)
  }
})
