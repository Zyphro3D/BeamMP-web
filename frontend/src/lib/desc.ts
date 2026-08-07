type Localised = Record<string, string> | string | null | undefined

/**
 * Extrait le texte dans la langue demandée depuis un champ description JSONB.
 * Fallback : fr → en → première langue disponible → chaîne vide.
 */
export function desc(description: Localised, lang: string): string {
  if (!description) return ''
  if (typeof description === 'string') return description
  return (
    description[lang] ??
    description.fr ??
    description.en ??
    Object.values(description)[0] ??
    ''
  )
}
