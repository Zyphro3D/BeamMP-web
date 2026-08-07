import { useState } from 'react'
import { CheckCircle2, FolderInput, RotateCcw } from 'lucide-react'
import { api, type ScanImportReport } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

export function SectionScanImport({ instanceId, onRefresh }: { instanceId: string; onRefresh: () => void }) {
  const { t } = useI18n()
  const [scanning, setScanning] = useState(false)
  const [report, setReport] = useState<ScanImportReport | null>(null)
  const [error, setError] = useState('')

  const runScan = async () => {
    setScanning(true)
    setError('')
    setReport(null)
    try {
      const result = await api.scanImport(instanceId)
      setReport(result)
      if (result.imported > 0) onRefresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setScanning(false)
    }
  }

  const statusColor = (status: 'imported' | 'skipped' | 'error') => {
    if (status === 'imported') return 'text-green-400'
    if (status === 'error')    return 'text-red-400'
    return 'text-zinc-500'
  }

  const typeLabel = (type?: string) => {
    if (type === 'vehicle') return t('vehicle')
    if (type === 'map')     return t('map_label')
    if (type === 'mod')     return t('mod')
    return '—'
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div className="card p-5 space-y-3">
        <div className="flex items-start gap-3">
          <FolderInput size={20} className="text-accent mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">{t('import_title')}</h2>
            <p className="text-xs text-zinc-500 mt-1">{t('import_desc')}</p>
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="btn-accent"
        >
          {scanning ? (
            <><RotateCcw size={14} className="animate-spin" />{t('import_scanning')}</>
          ) : (
            <><FolderInput size={14} />{t('import_run')}</>
          )}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Summary */}
      {report && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: t('import_total'),    value: report.total,    color: 'text-zinc-300' },
              { label: t('import_imported'), value: report.imported, color: 'text-green-400' },
              { label: t('import_skipped'),  value: report.skipped,  color: 'text-zinc-500' },
              { label: t('import_errors'),   value: report.errors,   color: 'text-red-400'  },
            ].map(({ label, value, color }) => (
              <div key={label} className="card p-4 text-center">
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-[11px] text-zinc-500 mt-1">{label}</p>
              </div>
            ))}
          </div>

          {/* Results table */}
          {report.results.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-3 border-b border-surface-border">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('import_results')}</p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border text-zinc-500">
                    <th className="text-left p-3 font-medium">{t('import_col_file')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_name')}</th>
                    <th className="text-left p-3 font-medium">{t('mod_type')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_image')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.map((r, idx) => (
                    <tr key={idx} className="border-b border-surface-border/50 last:border-0">
                      <td className="p-3 font-mono text-zinc-400 max-w-[180px] truncate">{r.filename}</td>
                      <td className="p-3 text-zinc-300">{r.name ?? '—'}</td>
                      <td className="p-3 text-zinc-500">{typeLabel(r.type)}</td>
                      <td className="p-3">
                        {r.hasImage
                          ? <CheckCircle2 size={13} className="text-green-400" />
                          : <span className="text-zinc-600">—</span>
                        }
                      </td>
                      <td className={`p-3 font-medium ${statusColor(r.status)}`}>
                        {t(`import_status_${r.status}`)}
                        {r.error && <span className="ml-1 text-red-400/70 font-normal">({r.error})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
