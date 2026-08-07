import { useState } from 'react'
import { api, type Mod } from '../lib/api'
import { useI18n } from '../context/I18nContext'

/**
 * Flux d'upload partagé par SectionMods et SectionMaps (formulaire simple :
 * un FormData, un appel, ferme la modale au succès). SectionUpload garde sa
 * propre logique — c'est une file d'items avec un statut par item, pas un
 * flag d'upload partagé, donc le forcer dans ce hook aurait été un mauvais
 * ajustement plutôt qu'une vraie déduplication.
 */
export function useModUpload(instanceId: string, onSuccess?: (mod: Mod) => void) {
  const { t } = useI18n()
  const [uploading, setUploading] = useState(false)
  const [error, setError]         = useState('')

  const upload = async (formData: FormData): Promise<Mod | null> => {
    setError('')
    setUploading(true)
    try {
      const mod = await api.uploadMod(instanceId, formData)
      onSuccess?.(mod)
      return mod
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
      return null
    } finally {
      setUploading(false)
    }
  }

  return { uploading, error, setError, upload }
}
