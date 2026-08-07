import { AlertCircle, AlertTriangle, Wrench } from 'lucide-react'
import type { ConsistencyIssue } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

export function IssueRow({ issue, issueTypeLabel, fixing, fixError, onFix }: {
  issue: ConsistencyIssue
  issueTypeLabel: Record<ConsistencyIssue['type'], string>
  fixing: boolean
  fixError?: string
  onFix: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="p-3 flex items-start gap-3">
      <div className={`mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
        {issue.severity === 'error' ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
            issue.severity === 'error'
              ? 'bg-red-500/15 text-red-400'
              : 'bg-yellow-500/15 text-yellow-400'
          }`}>
            {issueTypeLabel[issue.type]}
          </span>
        </div>
        <p className="text-xs text-zinc-700 dark:text-zinc-300 mt-1">{issue.description}</p>
        {fixError && <p className="text-[11px] text-red-400 mt-0.5">{fixError}</p>}
      </div>
      {issue.fix && (
        <button onClick={onFix} disabled={fixing}
          className="shrink-0 flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40">
          <Wrench size={11} />
          {fixing ? t('fixing') : t('fix')}
        </button>
      )}
    </div>
  )
}
