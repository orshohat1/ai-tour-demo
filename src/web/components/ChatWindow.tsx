import { useEffect, useRef, useState, useCallback, lazy, Suspense, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Message, StepKind, TimelineStep } from '../types'

// Lazy-load syntax highlighting (the largest dependency) to reduce initial bundle
const LazyHighlighter = lazy(() =>
  Promise.all([
    import('react-syntax-highlighter/dist/esm/prism-light'),
    import('react-syntax-highlighter/dist/esm/styles/prism/one-dark'),
  ]).then(([{ default: SyntaxHighlighter }, { default: oneDark }]) => ({
    default: ({ language, code }: { language: string; code: string }) => (
      <SyntaxHighlighter style={oneDark} language={language} PreTag="div">
        {code}
      </SyntaxHighlighter>
    ),
  }))
)

interface Props {
  messages: Message[]
  isStreaming: boolean
  onQuickReply?: (text: string) => void
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(err => console.error('Failed to copy:', err))
  }, [text])

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy code" aria-label="Copy code">
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
      )}
    </button>
  )
}

const STEP_ICONS: Record<StepKind, ReactElement> = {
  think: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 1.75a4.25 4.25 0 0 0-2.55 7.65c.28.21.43.49.43.79V11h4.24v-.81c0-.3.15-.58.43-.79A4.25 4.25 0 0 0 8 1.75ZM6.13 12.5h3.74v.75H6.13v-.75Zm.5 1.75h2.74l-.4.75H7.03l-.4-.75Z"/></svg>
  ),
  reasoning: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 1.75a4.25 4.25 0 0 0-2.55 7.65c.28.21.43.49.43.79V11h4.24v-.81c0-.3.15-.58.43-.79A4.25 4.25 0 0 0 8 1.75ZM6.13 12.5h3.74v.75H6.13v-.75Zm.5 1.75h2.74l-.4.75H7.03l-.4-.75Z"/></svg>
  ),
  tool: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M10.94 1a4 4 0 0 0-3.86 5.02L1.5 11.6a1.25 1.25 0 0 0 0 1.77l1.13 1.13a1.25 1.25 0 0 0 1.77 0l5.58-5.58A4 4 0 1 0 10.94 1Zm0 1.5a2.5 2.5 0 0 1 .7 4.9l-.5.14-5.86 5.86-.68-.68 5.86-5.86.14-.5A2.5 2.5 0 0 1 10.94 2.5Z"/></svg>
  ),
  action: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.81 3.75l1.44 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.19 6.25 9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.25.25 0 0 0 .108-.064L11.19 6.25Z"/></svg>
  ),
  agent: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M7.53 1.28a.5.5 0 0 1 .94 0l1.17 3.17 3.17 1.17a.5.5 0 0 1 0 .94l-3.17 1.17-1.17 3.17a.5.5 0 0 1-.94 0L6.36 7.73 3.19 6.56a.5.5 0 0 1 0-.94l3.17-1.17 1.17-3.17ZM12.5 9.5l.53 1.47 1.47.53-1.47.53-.53 1.47-.53-1.47L10.5 11.5l1.47-.53.53-1.47Z"/></svg>
  ),
  skill: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.75 1h8.5A1.75 1.75 0 0 1 12 2.75v10.5a.75.75 0 0 1-1.16.63L8 12.06l-2.84 1.82A.75.75 0 0 1 4 13.25V2.75C4 2.34 3.66 2 3.25 2H1.75a.75.75 0 0 1 0-1.5ZM5.5 2.75v9.13l2.09-1.34a.75.75 0 0 1 .82 0l2.09 1.34V2.75a.25.25 0 0 0-.25-.25H5.36c.09.23.14.49.14.75Z"/></svg>
  ),
  hook: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 0a1 1 0 0 1 1 1v1.07a4.5 4.5 0 0 1 3.43 3.43H13.5a1 1 0 0 1 0 2h-1.07A4.5 4.5 0 0 1 9 10.93V12.5a2.5 2.5 0 0 1-5 0 .75.75 0 0 1 1.5 0 1 1 0 0 0 2 0v-1.57A4.5 4.5 0 0 1 3.57 7.5H2.5a1 1 0 0 1 0-2h1.07A4.5 4.5 0 0 1 7 2.07V1a1 1 0 0 1 1-1Zm0 3.5A3 3 0 1 0 8 9.5a3 3 0 0 0 0-6Z"/></svg>
  ),
  approval: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 .5a3.5 3.5 0 0 1 3.5 3.5c0 .98-.4 1.86-1.05 2.5H12A1.5 1.5 0 0 1 13.5 8v5A1.5 1.5 0 0 1 12 14.5H4A1.5 1.5 0 0 1 2.5 13V8A1.5 1.5 0 0 1 4 6.5h1.55A3.5 3.5 0 0 1 8 .5Zm0 1.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm2.78 6.97-3.1 3.1-1.46-1.46a.75.75 0 1 0-1.06 1.06l1.99 1.99a.75.75 0 0 0 1.06 0l3.63-3.63a.75.75 0 1 0-1.06-1.06Z"/></svg>
  ),
}

/** Per-kind sub-label shown under the step title when none is provided. */
const KIND_SUB: Record<StepKind, string> = {
  think: 'Reasoning',
  reasoning: 'Remi\u2019s reasoning',
  tool: 'Grocery backend',
  action: 'Writes to the backend',
  agent: 'Foundry hosted agent',
  skill: 'Governed playbook',
  hook: 'Lifecycle hook',
  approval: 'Human-in-the-loop',
}

const KIND_VERB: Record<StepKind, string> = {
  think: 'Thinking',
  reasoning: 'Thinking',
  tool: 'Tool',
  action: 'Action',
  agent: 'Agent',
  skill: 'Skill',
  hook: 'Hook',
  approval: 'Approval',
}

/** Labels for the expandable request/response panes, per kind. */
function paneLabels(kind: StepKind): { req: string; res: string } {
  if (kind === 'agent') return { req: 'Remi asked', res: 'Specialist replied' }
  if (kind === 'action') return { req: 'Requested', res: 'Result' }
  return { req: 'Input', res: 'Output' }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
  )
}

function BlockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3.94 4.76a5 5 0 0 1 7.3 6.78L4.46 4.76a.4.4 0 0 1 .04-.06l-.56.06Zm-.7 1.06L9.78 12.3a5 5 0 0 1-6.54-6.48Z"/></svg>
  )
}

function Chevron() {
  return (
    <svg className="wl-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5.22 6.22a.75.75 0 0 1 1.06 0L8 7.94l1.72-1.72a.75.75 0 1 1 1.06 1.06l-2.25 2.25a.75.75 0 0 1-1.06 0L5.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg>
  )
}

/** One expandable row in the work log. Clicking reveals the actual payloads —
 *  e.g. the question Remi sent a specialist and the specialist's reply. */
function StepRow({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false)

  // Reasoning steps render as a narrative "thought" line, visually distinct
  // from tool/action rows (this is the model's thinking, not an action).
  if (step.kind === 'reasoning') {
    return (
      <li className="wl-step wl-reasoning complete">
        <div className="wl-thought">
          <span className="wl-thought-bullet" aria-hidden="true">{STEP_ICONS.reasoning}</span>
          <span className="wl-thought-text">{step.text}</span>
        </div>
      </li>
    )
  }

  const running = !step.done
  const failed = step.done && step.success === false
  const labels = paneLabels(step.kind)
  const hasDetail = Boolean(step.request || step.response || step.detail)

  return (
    <li className={`wl-step wl-${step.kind}${running ? ' running' : ' complete'}${failed || step.blocked ? ' failed' : ''}`}>
      <button
        className="wl-row"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
      >
        <span className="wl-bullet" aria-hidden="true">
          {running ? <span className="wl-spin" /> : STEP_ICONS[step.kind]}
        </span>
        <span className="wl-body">
          <span className="wl-label">{step.label}</span>
          <span className="wl-sub">{KIND_SUB[step.kind]}</span>
        </span>
        <span className="wl-state" aria-hidden="true">
          {running ? (
            <span className="wl-kind-tag">{KIND_VERB[step.kind]}</span>
          ) : step.blocked ? (
            <span className="wl-block"><BlockIcon /></span>
          ) : (
            <span className="wl-check"><CheckIcon /></span>
          )}
          {hasDetail && <Chevron />}
        </span>
      </button>

      {open && hasDetail && (
        <div className="wl-detail">
          {step.request && (
            <div className="wl-pane">
              <div className="wl-pane-label">{labels.req}</div>
              <pre className="wl-pane-body">{step.request}</pre>
            </div>
          )}
          {step.response && (
            <div className="wl-pane">
              <div className="wl-pane-label">{labels.res}</div>
              <pre className="wl-pane-body">{step.response}</pre>
            </div>
          )}
          {step.detail && (
            <div className="wl-pane">
              <div className="wl-pane-label">{step.kind === 'skill' ? 'Playbook' : 'Note'}</div>
              <pre className="wl-pane-body">{step.detail}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** A VS Code Copilot-style agentic work log: collapsible header + a vertical
 *  timeline of categorized, expandable steps (thinking, tools, actions,
 *  specialist agents, skills and lifecycle hooks). */
function WorkLog({
  timeline,
  streaming,
  startedAt,
  endedAt,
}: {
  timeline: TimelineStep[]
  streaming: boolean
  startedAt?: number
  endedAt?: number
}) {
  const [open, setOpen] = useState(true)
  if (timeline.length === 0) return null

  const actionCount = timeline.filter((s) => s.kind !== 'think' && s.kind !== 'reasoning').length
  const elapsed =
    startedAt && endedAt ? Math.max(1, Math.round((endedAt - startedAt) / 1000)) : null
  const summary = streaming
    ? 'Working\u2026'
    : elapsed
      ? `Worked for ${elapsed}s`
      : `${actionCount} step${actionCount === 1 ? '' : 's'}`

  return (
    <div className={`worklog${streaming ? ' live' : ''}`}>
      <button
        className="worklog-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {streaming ? <span className="wl-spin" aria-hidden="true" /> : <Chevron />}
        <span className="worklog-summary">{summary}</span>
        <span className="worklog-count">
          {actionCount} {actionCount === 1 ? 'step' : 'steps'}
        </span>
      </button>

      {open && (
        <ol className="worklog-steps">
          {timeline.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** Animated "thinking" shimmer shown before any tokens stream in. */
function Thinking({ label }: { label: string }) {
  return (
    <div className="wl-thinking">
      <span className="wl-spin" aria-hidden="true" />
      <span className="wl-thinking-text">{label}</span>
    </div>
  )
}

/** The live, in-progress thought stream shown while Remi is still working. */
function LiveThought({ text }: { text: string }) {
  return (
    <div className="live-thought">
      <span className="wl-spin" aria-hidden="true" />
      <span className="live-thought-text">{text}</span>
    </div>
  )
}

/** Human-in-the-loop approval gate: Remi pauses, the human decides. */
function ApprovalCard({
  action,
  detail,
  disabled,
  onApprove,
  onDecline,
}: {
  action: string
  detail: string
  disabled?: boolean
  onApprove: () => void
  onDecline: () => void
}) {
  const [decided, setDecided] = useState<null | 'approved' | 'declined'>(null)
  return (
    <div className={`approval-card${decided ? ` decided ${decided}` : ''}`}>
      <div className="approval-head">
        <span className="approval-badge">{STEP_ICONS.approval} Approval needed</span>
        <span className="approval-sub">Human-in-the-loop</span>
      </div>
      <div className="approval-action">{action}</div>
      {detail && <div className="approval-detail">{detail}</div>}
      {decided ? (
        <div className={`approval-result ${decided}`}>
          {decided === 'approved' ? '✓ Approved — Remi is proceeding' : '✕ Declined — Remi will not proceed'}
        </div>
      ) : (
        <div className="approval-actions">
          <button
            className="approval-btn decline"
            disabled={disabled}
            onClick={() => { setDecided('declined'); onDecline() }}
          >
            Decline
          </button>
          <button
            className="approval-btn approve"
            disabled={disabled}
            onClick={() => { setDecided('approved'); onApprove() }}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  )
}

export function ChatWindow({ messages, isStreaming, onQuickReply }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="messages">
        <div className="empty-state">Send a message to get started</div>
      </div>
    )
  }

  return (
    <div className="messages">
      {messages.map((msg, i) => {
        const isLast = i === messages.length - 1
        const streaming = msg.role === 'assistant' && isStreaming && isLast
        const hasWork = msg.role === 'assistant' && !!msg.timeline && msg.timeline.length > 0
        const liveText = msg.streamingText?.trim()

        if (msg.role !== 'assistant') {
          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              {msg.content}
            </div>
          )
        }

        return (
          <div key={msg.id} className={`message assistant${streaming ? ' streaming' : ''}`}>
            {hasWork && (
              <WorkLog
                timeline={msg.timeline!}
                streaming={streaming}
                startedAt={msg.startedAt}
                endedAt={msg.endedAt}
              />
            )}

            {streaming && liveText && <LiveThought text={liveText} />}
            {streaming && !liveText && !msg.content && <Thinking label={hasWork ? 'Working\u2026' : 'Thinking\u2026'} />}

            {msg.content && (
              <div className="answer">
                <div className="answer-label">
                  <span className="answer-dot" aria-hidden="true" />
                  Remi
                </div>
                <div className="answer-body">
                  <ReactMarkdown
                    components={{
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '')
                        const code = String(children).replace(/\n$/, '')
                        if (match) {
                          return (
                            <div className="code-block-wrapper">
                              <CopyButton text={code} />
                              <Suspense fallback={<pre><code>{code}</code></pre>}>
                                <LazyHighlighter language={match[1]} code={code} />
                              </Suspense>
                            </div>
                          )
                        }
                        return <code className={className} {...props}>{children}</code>
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {msg.pendingApproval && isLast && (
              <ApprovalCard
                action={msg.pendingApproval.action}
                detail={msg.pendingApproval.detail}
                disabled={streaming || !onQuickReply}
                onApprove={() => onQuickReply?.(`Approved — go ahead with: ${msg.pendingApproval!.action}`)}
                onDecline={() => onQuickReply?.(`Declined — do not proceed with: ${msg.pendingApproval!.action}. Save a draft only and explain the alternative.`)}
              />
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
