/** Keep literal dictated markers; never turn an ASR description of noise into a new request. */
export const isDictation = (text: string) => /^(?:напиши|запиши|продиктуй|диктуй|скажи|write|type|dictate|say|scrie|dictează|dicteaza|spune)(?:[\s,:]|$)/iu.test(text.trim())

export function nonSpeechTranscript(raw: string, command = raw): boolean {
  if (isDictation(command)) return false
  return /(?:\[|\()(?:\s*)(?:music|inaudible|unintelligible|indistinct(?:\s+chatter)?|background(?:\s+(?:noise|music|speech))?|noise|silence|applause|laughter|музыка|неразборчиво|неразборчивая речь|шум|тишина|aplauze|muzică|muzica|neinteligibil|zgomot)(?:\s|\]|\)|[.:])/iu.test(raw)
}
