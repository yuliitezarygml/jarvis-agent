import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage, romanianDiacritics } from '../src/shared/language.ts'
import { dicts, resolveLocale, translate } from '../src/renderer/src/i18n.ts'
import { conversationControl, conversationPause } from '../src/shared/conversation.ts'
import { normalize } from '../src/shared/textmatch.ts'
import { needsContinuation } from '../src/main/speech/command-buffer.ts'
import { buildSystemExtra } from '../src/main/agent-prompt.ts'

test('automatic interface follows requests RU → RO → EN, manual choice overrides, OS is only a fallback', () => {
  assert.equal(resolveLocale('auto', 'ru', 'en-US'), 'ru')
  assert.equal(resolveLocale('auto', 'ro', 'ru-RU'), 'ro')
  assert.equal(resolveLocale('auto', 'en', 'ro-RO'), 'en')
  assert.equal(resolveLocale('ru', 'ro', 'en-US'), 'ru')
  assert.equal(resolveLocale('ro', 'en', 'ru-RU'), 'ro')
  assert.equal(resolveLocale('auto', '', 'ro-MD'), 'ro')
})

test('Romanian diacritics survive normalisation and older cedillas are corrected without inventing accents', () => {
  assert.equal(romanianDiacritics('Ştiinţă şi țară, câine, învățământ, bună'), 'Știință și țară, câine, învățământ, bună')
  assert.equal(normalize('Încheie conversația!'), 'încheie conversația')
  assert.equal(romanianDiacritics('bună'.normalize('NFD')), 'bună')
})

test('language detection supports switching and keeps ambiguous short replies in the current language', () => {
  assert.equal(detectLanguage('Открой Spotify', 'en'), 'ru')
  assert.equal(detectLanguage('Bună! Arată-mi fișierul.', 'ru'), 'ro')
  assert.equal(detectLanguage('te rog deschide calculatorul', 'en'), 'ro')
  assert.equal(detectLanguage('Hello, please open the file', 'ro'), 'en')
  assert.equal(detectLanguage('OK', 'ro'), 'ro')
  assert.equal(detectLanguage('Да', 'ro'), 'ru')
})

test('Romanian mode controls work with accents and a trailing name, quoted examples stay data', () => {
  const aliases = ['jarvis', 'джарвис']
  assert.deepEqual(conversationControl('Jarvis, hai să vorbim despre vacanță', aliases), { action: 'start', topic: 'vacanță' })
  assert.deepEqual(conversationControl('Hai să vorbim, Jarvis', aliases), { action: 'start', topic: '' })
  assert.deepEqual(conversationControl('Jarvis, încheie conversația', aliases), { action: 'end' })
  assert.deepEqual(conversationControl('Jarvis, încheie conversaţia', aliases), { action: 'end' })
  assert.equal(conversationControl('Explică expresia „hai să vorbim”', aliases), null)
  assert.equal(conversationPause('Așteaptă!'), true)
  assert.equal(needsContinuation('deschide'), true)
  assert.equal(needsContinuation('mută fișierul în'), true)
  assert.equal(needsContinuation('deschide calculatorul'), false)
})

test('Romanian translations cover the dictionary and show accented status and hints', () => {
  const missing = Object.keys(dicts.en).filter((key) => !dicts.ro[key])
  assert.deepEqual(missing, [])
  assert.equal(translate('ru', 'state.idle'), 'Жду команды')
  assert.equal(translate('ro', 'state.idle'), 'Aștept comanda')
  assert.equal(translate('ro', 'home.hint', { hotkey: 'Ctrl+Alt+J' }), 'Spune „Jarvis” sau apasă Ctrl+Alt+J')
  assert.equal(Object.values(dicts.ro).some((text) => /[şţ]/i.test(text)), false)
})

test('Romanian agent context explicitly requests modern diacritics for replies and questions', () => {
  const system = buildSystemExtra({ memory: '', routines: [], lang: 'Romanian', via: 'voice', screen: '1920x1080', vision: true, time: 'now', custom: '' })
  assert.match(system, /Language: Romanian/)
  assert.match(system, /ă, â, î, ș, ț/)
  assert.match(system, /Do not transliterate Romanian into ASCII/)
})
