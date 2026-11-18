// The RU-only recogniser can transliterate foreign speech into Cyrillic.
// Require distinct Russian words before bypassing multilingual detection.
const RUSSIAN_WORDS = new Set((
  'давай давайте пообщаемся поговорим поболтаем включи начни режим разговора общения ' +
  'закончим закончи заверши разговор вернись ожидания как что где когда почему зачем ' +
  'какой какая какие сколько это меня тебе тебя мой моя твой твоя дела умеешь можешь ' +
  'открой закрой найди поищи покажи запусти выключи создай удали перенеси скопируй ' +
  'напиши запиши отправь сохрани расскажи объясни пожалуйста браузер папку файл ' +
  'документы загрузки настройки музыку погоду сегодня сейчас интернете информацию ' +
  'вопрос ответ команду помоги привет спасибо хорошо слышишь слушай продолжай'
).split(' '))

/** A conservative fast path; short names and foreign transliterations are insufficient. */
export function confidentRussian(text: string): boolean {
  const clean = text.toLowerCase().replace(/ё/g, 'е')
  const cyr = (clean.match(/[а-я]/g) || []).length
  const lat = (clean.match(/[a-zăâîșț]/g) || []).length
  if (cyr < 4 || lat > cyr) return false
  const words = new Set(clean.match(/[а-я]+/g) || [])
  return [...words].filter((word) => RUSSIAN_WORDS.has(word)).length >= 2
}
