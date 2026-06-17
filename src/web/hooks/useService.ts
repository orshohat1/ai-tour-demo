import { useState, useRef, useCallback } from 'react'
import type { Message, TimelineStep } from '../types'
import { classifyToolKind } from '../types'

export function useService() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const messagesRef = useRef<Message[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (text: string) => {
    // Abort any in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    const assistantId = crypto.randomUUID()
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', startedAt: Date.now() }

    messagesRef.current = [...messagesRef.current, userMsg, assistantMsg]
    setMessages([...messagesRef.current])
    setIsLoading(true)

    // Build history from previous messages (exclude current)
    const history = messagesRef.current
      .filter(m => m.id !== assistantId && (m.role === 'user' || m.role === 'assistant'))
      .map(m => ({ role: m.role, content: m.content }))
    // Remove last entry (it's the current user message, we pass it as `message`)
    history.pop()

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.length > 0 ? history : undefined }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`)
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      // `pendingText` holds streamed model text not yet classified. Text that
      // arrives BEFORE a tool/skill becomes a "reasoning" step (the model's
      // thinking); whatever remains at the end is the final answer.
      let pendingText = ''
      let reasoningSeq = 0
      let buffer = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          // Keep the last (possibly incomplete) line in the buffer
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                if (parsed.error) {
                  throw new Error(parsed.error)
                }
                // Upsert a timeline step (tool / skill / hook) by id, preserving
                // arrival order so the work log reads as a true sequence.
                const upsertStep = (step: TimelineStep, merge = false) => {
                  messagesRef.current = messagesRef.current.map(m => {
                    if (m.id !== assistantId) return m
                    const timeline = [...(m.timeline ?? [])]
                    const idx = timeline.findIndex(t => t.id === step.id)
                    if (idx === -1) {
                      timeline.push(step)
                    } else if (merge) {
                      timeline[idx] = {
                        ...timeline[idx],
                        ...step,
                        // keep the request captured at start if complete omits it
                        request: step.request ?? timeline[idx].request,
                      }
                    }
                    return { ...m, timeline }
                  })
                  setMessages([...messagesRef.current])
                }

                // Lock any buffered text as a "reasoning" step before the next
                // action — this is the model's thinking that led to the tool call.
                const flushReasoning = () => {
                  const text = pendingText.trim()
                  pendingText = ''
                  messagesRef.current = messagesRef.current.map(m => {
                    if (m.id !== assistantId) return m
                    const next = { ...m, streamingText: '' }
                    if (text) {
                      next.timeline = [
                        ...(m.timeline ?? []),
                        { id: `r${reasoningSeq++}`, kind: 'reasoning' as const, name: 'reasoning', label: 'Thinking', done: true, text },
                      ]
                    }
                    return next
                  })
                  setMessages([...messagesRef.current])
                }

                if (parsed.tool) {
                  const { callId, name, label, phase, success, request, response } = parsed.tool as {
                    callId: string
                    name: string
                    label: string
                    phase: 'start' | 'complete'
                    success?: boolean
                    request?: string
                    response?: string
                  }
                  if (phase === 'start') flushReasoning()
                  const kind = classifyToolKind(name)
                  upsertStep(
                    {
                      id: callId,
                      kind,
                      name,
                      label: kind === 'think' ? 'Planning the approach' : label,
                      done: phase === 'complete',
                      success: phase === 'complete' ? success !== false : undefined,
                      request,
                      response,
                    },
                    true,
                  )
                  continue
                }
                if (parsed.skill) {
                  const { id, name, label, detail } = parsed.skill as {
                    id: string; name: string; label: string; detail?: string
                  }
                  flushReasoning()
                  upsertStep({ id, kind: 'skill', name, label, done: true, detail }, true)
                  continue
                }
                if (parsed.hook) {
                  const { id, name, label, detail, blocked } = parsed.hook as {
                    id: string; name: string; label: string; detail?: string; blocked?: boolean
                  }
                  upsertStep({ id, kind: 'hook', name, label, done: true, detail, blocked }, true)
                  continue
                }
                if (parsed.approval) {
                  const { action, detail } = parsed.approval as { action: string; detail: string }
                  messagesRef.current = messagesRef.current.map(m =>
                    m.id === assistantId ? { ...m, pendingApproval: { action, detail } } : m,
                  )
                  setMessages([...messagesRef.current])
                  continue
                }
                if (parsed.content) {
                  pendingText += parsed.content
                  const live = pendingText
                  messagesRef.current = messagesRef.current.map(m =>
                    m.id === assistantId ? { ...m, streamingText: live } : m,
                  )
                  setMessages([...messagesRef.current])
                }
              } catch (e) {
                if (e instanceof SyntaxError) continue
                throw e
              }
            }
          }
        }
      }

      // Whatever text remains after the last action is the final answer.
      const answer = pendingText.trim()
      messagesRef.current = messagesRef.current.map(m => {
        if (m.id !== assistantId) return m
        const hasWork = !!(m.timeline && m.timeline.length > 0)
        return {
          ...m,
          streamingText: '',
          content: answer || (hasWork ? '' : '(empty response)'),
        }
      })
      setMessages([...messagesRef.current])
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      messagesRef.current = messagesRef.current.map(m =>
        m.id === assistantId ? {
          ...m,
          role: 'error' as const,
          content: err instanceof Error ? err.message : 'Unknown error',
        } : m,
      )
      setMessages([...messagesRef.current])
    } finally {
      messagesRef.current = messagesRef.current.map(m =>
        m.id === assistantId && m.endedAt === undefined ? { ...m, endedAt: Date.now() } : m,
      )
      setMessages([...messagesRef.current])
      setIsLoading(false)
    }
  }, [])

  return { messages, isLoading, sendMessage }
}
