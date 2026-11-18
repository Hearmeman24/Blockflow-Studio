import { toast } from 'sonner'
import { countBrokenFlowReferences } from '@/lib/byok/flow-references'
import type { SavedFlow } from './flow-io'
import { CURRENT_FLOW_SCHEMA_VERSION, type FlowImportReport } from './flow-migrations'

/** What was opened, for the wording of the notice. */
export type FlowImportSubject = 'flow' | 'workspace' | 'run'

const MAX_NAMES = 5
const MAX_WARNINGS = 3

function listWithMore(items: string[], max: number, separator: string): string {
  if (items.length <= max) return items.join(separator)
  return `${items.slice(0, max).join(separator)} and ${items.length - max} more`
}

function referencesNotFound(count: number): string {
  return `${count} ${count === 1 ? 'reference' : 'references'} could not be found.`
}

/**
 * Toast text for an import report, or null when nothing needs the user's
 * attention. `brokenReferences` is the count from the reference check.
 */
export function summarizeFlowImport(
  report: FlowImportReport,
  subject: FlowImportSubject,
  brokenReferences = 0,
): { title: string; description: string } | null {
  const unsupported = report.unsupported.length
  const warnings = report.warnings.length
  const brokenNote = brokenReferences > 0 ? ` ${referencesNotFound(brokenReferences)}` : ''
  if (unsupported > 0) {
    const names = listWithMore(report.unsupported.map((u) => u.label), MAX_NAMES, ', ')
    const pronoun = unsupported === 1 ? 'it' : 'them'
    let description = `${names}. Remove or disable ${pronoun} before running.`
    if (warnings > 0) {
      description += ` ${warnings} ${warnings === 1 ? 'problem' : 'problems'} in the file ${warnings === 1 ? 'was' : 'were'} fixed.`
    }
    return {
      title: `${unsupported} ${unsupported === 1 ? 'block' : 'blocks'} in this ${subject} ${unsupported === 1 ? 'is' : 'are'} no longer supported`,
      description: description + brokenNote,
    }
  }
  if (warnings > 0) {
    const listed = listWithMore(report.warnings, MAX_WARNINGS, ' ')
    return {
      title: `This ${subject} was opened with ${warnings} ${warnings === 1 ? 'fix' : 'fixes'}`,
      description: (report.warnings.length > MAX_WARNINGS ? `${listed}.` : listed) + brokenNote,
    }
  }
  if (brokenReferences > 0) {
    return {
      title: `${brokenReferences} ${brokenReferences === 1 ? 'reference' : 'references'} in this ${subject} could not be found`,
      description: 'They are marked on their blocks. Replace or remove them before running.',
    }
  }
  return null
}

let noticeCounter = 0

/**
 * Surface an import report once, without blocking. With `flows`, the saved
 * references are checked in the background and the same toast is updated (or
 * shown) with the number that could not be found. A failed check adds nothing.
 */
export async function notifyFlowImport(
  report: FlowImportReport,
  subject: FlowImportSubject,
  flows?: readonly SavedFlow[],
): Promise<void> {
  const summary = summarizeFlowImport(report, subject)
  if (!flows) {
    if (summary) toast.warning(summary.title, { description: summary.description })
    return
  }
  const id = `flow-import-${++noticeCounter}`
  if (summary) toast.warning(summary.title, { id, description: summary.description })
  const broken = await countBrokenFlowReferences(flows)
  if (!broken) return
  const withReferences = summarizeFlowImport(report, subject, broken)!
  toast.warning(withReferences.title, { id, description: withReferences.description })
}

export function notifyFlowImportFailure(error: string, subject: FlowImportSubject = 'flow'): void {
  toast.error(`Could not open the ${subject}`, { description: error })
}

/** Combine per-tab reports (workspace import) into one. */
export function mergeImportReports(reports: FlowImportReport[]): FlowImportReport {
  return {
    from_version: reports.length > 0 ? Math.min(...reports.map((r) => r.from_version)) : CURRENT_FLOW_SCHEMA_VERSION,
    to_version: CURRENT_FLOW_SCHEMA_VERSION,
    unsupported: reports.flatMap((r) => r.unsupported),
    warnings: reports.flatMap((r) => r.warnings),
  }
}
