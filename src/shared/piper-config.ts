/** The bundled 2023 Piper CLI accepts one Unicode codepoint per phoneme-map key. */
export function isLegacyPiperConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const config = value as { phoneme_id_map?: unknown; phoneme_type?: unknown }
  if (config.phoneme_type !== 'espeak' && config.phoneme_type !== 'text') return false
  const map = config.phoneme_id_map
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false
  const entries = Object.entries(map)
  return entries.length > 0 && entries.every(([phoneme, ids]) =>
    [...phoneme].length === 1 && Array.isArray(ids) && ids.length > 0 && ids.every((id) => Number.isInteger(id) && id >= 0)
  )
}
