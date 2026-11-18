import type { Lang } from './types'

export const isLang = (value: string): value is Lang => value === 'ru' || value === 'ro' || value === 'en'

/** Romanian uses comma-below ș/ț; older recognisers sometimes return cedillas. */
export const romanianDiacritics = (text: string): string => text.normalize('NFC').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')

const ro = new Set('bună salut mulțumesc multumesc deschide închide inchide caută cauta vreau trebuie sunt este nu acum unde cum pentru acest această acesta fișierul fisierul dosarul calculatorul te rog vorbește vorbeste spune arată arata română romana și sau hai să sa întrebarea'.split(' '))
const en = new Set('hello hi thanks thank please open close find search want need is are not now where how for this that file folder tell show english the my your let talk'.split(' '))

/** Short ambiguous replies retain the current language; a verified ASR language takes precedence at input. */
export function detectLanguage(text: string, fallback: Lang = 'en'): Lang {
  const clean = romanianDiacritics(text).toLowerCase()
  const cyr = (clean.match(/[а-яё]/g) || []).length
  const lat = (clean.match(/[a-zăâîșț]/g) || []).length
  if (cyr > 0 && (cyr >= lat / 2 || /(?:^|\s)(да|нет|открой|найди|что|как|я)(?:\s|$)/.test(clean))) return 'ru'
  if (/[ăâîșț]/.test(clean)) return 'ro'
  const words = clean.match(/\p{L}+/gu) ?? []
  const scoreRo = words.filter((w) => ro.has(w)).length
  const scoreEn = words.filter((w) => en.has(w)).length
  if (scoreRo > scoreEn) return 'ro'
  if (scoreEn > scoreRo) return 'en'
  return fallback
}

export const languageName: Record<Lang, string> = { ru: 'Russian', ro: 'Romanian', en: 'English' }

/** Auto follows a recognised request, then the last request across restarts, then the OS locale. */
export function interfaceLanguage(pref: string, input = '', system = 'en'): Lang {
  if (isLang(pref)) return pref
  if (isLang(input)) return input
  const locale = system.toLowerCase().split(/[-_]/)[0]
  return isLang(locale) ? locale : 'en'
}
