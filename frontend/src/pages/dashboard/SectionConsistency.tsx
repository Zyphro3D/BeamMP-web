import { useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ScanSearch, Wrench } from 'lucide-react'
import { api, type ConsistencyIssue, type ConsistencyReport } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { IssueRow } from '../../components/admin/IssueRow'

export function SectionConsistency({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [fixing, setFixing] = useState<Set<string>>(new Set())
  const [fixed, setFixed] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const scan = async () => {
    setLoading(true)
    setFixed(new Set())
    setErrors({})
    try {
      const r = await api.checkConsistency(instanceId)
      setReport(r)
    } catch (err: unknown) {
      setErrors({ _scan: err instanceof Error ? err.message : t('scan_error') })
    } finally {
      setLoading(false)
    }
  }

  const fixOne = async (issue: ConsistencyIssue) => {
    if (!issue.fix || !issue.meta) return
    setFixing(s => new Set(s).add(issue.id))
    try {
      await api.fixConsistency(instanceId, issue.fix, issue.meta)
      setFixed(s => new Set(s).add(issue.id))
    } catch (err: unknown) {
      setErrors(e => ({ ...e, [issue.id]: err instanceof Error ? err.message : t('error') }))
    } finally {
      setFixing(s => { const n = new Set(s); n.delete(issue.id); return n })
    }
  }

  const fixAll = async (issues: ConsistencyIssue[]) => {
    for (const issue of issues) {
      if (issue.fix && issue.meta && !fixed.has(issue.id)) await fixOne(issue)
    }
  }

  const remainingIssues = report?.issues.filter(i => !fixed.has(i.id)) ?? []
  const errors_ = remainingIssues.filter(i => i.severity === 'error')
  const warnings = remainingIssues.filter(i => i.severity === 'warning')
  const allFixed = report && remainingIssues.length === 0

  const issueTypeLabel: Record<ConsistencyIssue['type'], string> = {
    wrong_location:       t('issue_wrong_location'),
    missing_file:         t('issue_missing_file'),
    orphan_file:          t('issue_orphan_file'),
    missing_image:        t('issue_missing_image'),
    orphan_image:         t('issue_orphan_image'),
    multiple_active_maps: t('issue_multiple_active_maps'),
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-500">
            {t('consistency_desc')}
          </p>
          {report && (
            <p className="text-[11px] text-zinc-600 mt-0.5">
              {t('last_scan')} {new Date(report.scannedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button onClick={scan} disabled={loading} className="btn-accent gap-2">
          <ScanSearch size={14} />
          {loading ? t('scan_running') : t('launch_scan')}
        </button>
      </div>

      {errors._scan && (
        <div className="card p-4 border border-red-500/30 bg-red-500/5">
          <p className="text-sm text-red-400">{errors._scan}</p>
        </div>
      )}

      {/* Summary */}
      {report && (
        <div className="grid grid-cols-3 gap-3">
          <div className="stat-card">
            <p className="text-xs text-zinc-500">{t('total_issues')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{remainingIssues.length}</p>
            <p className="text-[11px] text-zinc-600">{t('remaining_issues')}</p>
          </div>
          <div className={`stat-card ${errors_.length > 0 ? 'border-red-500/30' : ''}`}>
            <p className="text-xs text-zinc-500 flex items-center gap-1"><AlertCircle size={11} className="text-red-400" /> {t('errors_label')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-red-400">{errors_.length}</p>
            <p className="text-[11px] text-zinc-600">{t('to_fix')}</p>
          </div>
          <div className={`stat-card ${warnings.length > 0 ? 'border-yellow-500/30' : ''}`}>
            <p className="text-xs text-zinc-500 flex items-center gap-1"><AlertTriangle size={11} className="text-yellow-400" /> {t('warnings_label')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-yellow-400">{warnings.length}</p>
            <p className="text-[11px] text-zinc-600">{t('optional_label')}</p>
          </div>
        </div>
      )}

      {/* All OK */}
      {allFixed && (
        <div className="card p-6 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 size={32} className="text-green-400" />
          <p className="text-sm font-semibold text-green-400">{t('all_ok')}</p>
          <p className="text-xs text-zinc-500">{t('all_ok_desc')}</p>
        </div>
      )}

      {/* Errors block */}
      {errors_.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wider flex items-center gap-1.5">
              <AlertCircle size={13} /> {t('errors_label')} ({errors_.length})
            </span>
            <button onClick={() => fixAll(errors_)} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Wrench size={11} /> {t('fix_all')}
            </button>
          </div>
          <div className="divide-y divide-surface-border">
            {errors_.map(issue => (
              <IssueRow key={issue.id} issue={issue} issueTypeLabel={issueTypeLabel}
                fixing={fixing.has(issue.id)} fixError={errors[issue.id]}
                onFix={() => fixOne(issue)} />
            ))}
          </div>
        </div>
      )}

      {/* Warnings block */}
      {warnings.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-yellow-400 uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle size={13} /> {t('warnings_label')} ({warnings.length})
            </span>
            <button onClick={() => fixAll(warnings)} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Wrench size={11} /> {t('fix_all')}
            </button>
          </div>
          <div className="divide-y divide-surface-border">
            {warnings.map(issue => (
              <IssueRow key={issue.id} issue={issue} issueTypeLabel={issueTypeLabel}
                fixing={fixing.has(issue.id)} fixError={errors[issue.id]}
                onFix={() => fixOne(issue)} />
            ))}
          </div>
        </div>
      )}

      {!report && !loading && !errors._scan && (
        <div className="card p-10 text-center text-zinc-700 text-sm">
          <ScanSearch size={28} className="mx-auto mb-3 opacity-40" />
          {t('scan_instruction')}
        </div>
      )}
    </div>
  )
}
