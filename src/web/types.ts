/** A category of work step in the assistant's agentic timeline. */
export type StepKind = 'think' | 'reasoning' | 'tool' | 'action' | 'agent' | 'skill' | 'hook' | 'approval'

/** One entry in the Copilot-style work log: a tool call, a skill, or a hook. */
export interface TimelineStep {
  /** Stable id — tool callId, or skill-/hook-/reasoning-prefixed id. */
  id: string
  kind: StepKind
  /** Raw name as reported by the SDK, e.g. "consult_forecast". */
  name: string
  /** Friendly label, e.g. "Consulting Demand-Forecast specialist". */
  label: string
  /** Whether the step has completed. */
  done: boolean
  /** Whether a completed step succeeded (defaults to true). */
  success?: boolean
  /** What Remi sent (tool/agent input, or a hook's note). */
  request?: string
  /** What came back (tool/agent output). */
  response?: string
  /** Extra detail — skill content, hook note, or a thinking intent. */
  detail?: string
  /** Free-form reasoning text (for kind 'reasoning'). */
  text?: string
  /** A governance hook that blocked an action. */
  blocked?: boolean
}

/** Tool names that mutate the backend — shown as "action" steps. */
const ACTION_TOOLS = new Set([
  'create_purchase_order',
  'receive_stock',
  'adjust_stock',
  'record_stock_count',
  'write_off_expired',
  'set_reorder_policy',
  'set_product_status',
])

/** Map an SDK tool name to a timeline step category. */
export function classifyToolKind(name: string): StepKind {
  if (name === 'report_intent' || name === 'think') return 'think'
  if (name === 'request_approval') return 'approval'
  if (name.startsWith('consult_')) return 'agent'
  if (ACTION_TOOLS.has(name)) return 'action'
  return 'tool'
}

/** A pending human-in-the-loop approval shown with Approve / Decline buttons. */
export interface PendingApproval {
  action: string
  detail: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  /** Ordered work log the assistant produced for this message. */
  timeline?: TimelineStep[]
  /** Live, not-yet-classified streaming text (reasoning or final answer). */
  streamingText?: string
  /** A human-in-the-loop approval request awaiting the user's decision. */
  pendingApproval?: PendingApproval
  /** Epoch ms when the assistant turn started (for the work-log timer). */
  startedAt?: number
  /** Epoch ms when the assistant turn finished. */
  endedAt?: number
}
