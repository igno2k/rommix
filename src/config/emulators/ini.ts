/**
 * Reading one value out of an emulator's INI file.
 *
 * PCSX2, Dolphin and DuckStation all write the same plain shape — `[Section]`
 * headers and `Key = Value` lines — and a descriptor needs one or two values
 * out of a file of hundreds, so this is a lookup rather than a parser that
 * builds a model of the whole file. Section and key names compare without case,
 * as the emulators' own readers do.
 */

/** The value of `key` under `[section]`, trimmed, or null where either is absent. */
export function iniValue(text: string | null, section: string, key: string): string | null {
  if (text === null) return null
  const wantedSection = section.toLowerCase()
  const wantedKey = key.toLowerCase()
  let inSection = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[([^\]]*)\]$/.exec(line)
    if (header) {
      inSection = header[1].trim().toLowerCase() === wantedSection
      continue
    }
    if (!inSection || line.startsWith(';') || line.startsWith('#')) continue
    const cut = line.indexOf('=')
    if (cut === -1) continue
    if (line.slice(0, cut).trim().toLowerCase() === wantedKey) return line.slice(cut + 1).trim()
  }
  return null
}
