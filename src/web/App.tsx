import { useEffect, useRef, useState } from 'react'
import './App.css'
import { ChatWindow } from './components/ChatWindow'
import { MessageInput } from './components/MessageInput'
import { ThemeToggle } from './components/ThemeToggle'
import { useService } from './hooks/useService'
import { useTheme } from './hooks/useTheme'
import { useInventory, type InventoryProduct } from './hooks/useInventory'

const NAV_ITEMS = [
  { icon: '◫', label: 'Dashboard', active: true },
  { icon: '▦', label: 'Catalog', active: false },
  { icon: '↻', label: 'Purchase orders', active: false },
  { icon: '⚑', label: 'Suppliers', active: false },
  { icon: '⚙', label: 'Settings', active: false },
]

const SPECIALISTS = [
  { icon: '📦', name: 'Inventory', sub: 'stock · expiry · cold-chain', tone: 'spec-inv' },
  { icon: '📈', name: 'Demand-Forecast', sub: 'demand · reorder qty', tone: 'spec-fc' },
  { icon: '🛡️', name: 'Supplier & Compliance', sub: 'suppliers · regulatory', tone: 'spec-comp' },
]

const SUGGESTIONS = [
  "We're low on Spring Water and Iced Tea — what should I reorder?",
  'Write off any expired stock and put slow near-expiry items on clearance',
  'Receive 2 cases of Spring Water and recount the Greek Yogurt shelf',
]

const CAT_COLOR: Record<string, string> = {
  'Produce': 'var(--cat-probiotics)',
  'Dairy & Eggs': 'var(--cat-vitamins)',
  'Beverages': 'var(--cat-omega)',
  'Pantry': 'var(--cat-minerals)',
  'Snacks': 'var(--cat-sports)',
  'Household': 'var(--cat-protein)',
  'Frozen': 'var(--cat-omega)',
}

function sparkTone(trendPct: number | null): 'up' | 'down' | 'flat' {
  if (trendPct == null || Math.abs(trendPct) < 4) return 'flat'
  return trendPct > 0 ? 'up' : 'down'
}

/** Gradient-filled area mini-graph of weekly sales over the last month. */
function SalesGraph({ values, tone, gid }: { values: number[]; tone: 'up' | 'down' | 'flat'; gid: string }) {
  if (!values || values.length < 2) return <span className="muted">—</span>
  const w = 88
  const h = 30
  const pad = 3
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = (w - pad * 2) / (values.length - 1)
  const pts = values.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`
  const color = tone === 'up' ? 'var(--success)' : tone === 'down' ? 'var(--error-text)' : 'var(--text-tertiary)'
  return (
    <svg className="sales-graph" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.4" fill={color} />
    </svg>
  )
}

/** Reorder / lifecycle status shown as a plain, readable badge. */
function statusCell(p: InventoryProduct) {
  if (p.status === 'hold') return <span className="status-badge st-hold">On hold</span>
  if (p.status === 'clearance')
    return (
      <span className="status-badge st-clearance">
        Clearance{p.markdownPct ? ` −${Math.round(p.markdownPct * 100)}%` : ''}
      </span>
    )
  if (p.expiredUnits > 0) return <span className="status-badge st-expired">{p.expiredUnits} expired</span>
  if (p.low) return <span className="status-badge st-reorder">Reorder now</span>
  if (p.nearExpiry) return <span className="status-badge st-expiry">Near expiry</span>
  return <span className="status-badge st-active">OK</span>
}

export default function App() {
  const { messages, isLoading, sendMessage } = useService()
  const { theme, toggleTheme } = useTheme()
  const { data, refresh, changedSkus } = useInventory()

  // Inventory table pagination.
  const PAGE_SIZE = 6
  const [page, setPage] = useState(0)

  // Re-pull the board whenever the assistant finishes a turn, so actions Remi
  // takes (receive, adjust, write-off, clearance, PO) appear immediately.
  const wasLoading = useRef(false)
  useEffect(() => {
    if (wasLoading.current && !isLoading) void refresh()
    wasLoading.current = isLoading
  }, [isLoading, refresh])

  const kpis = data?.kpis
  const kpiCards = kpis
    ? [
        { label: 'Active SKUs', value: String(kpis.activeSkus), sub: 'in this category', tone: 'brand', icon: '▦' },
        { label: 'Low stock', value: String(kpis.lowStock), sub: 'need reorder', tone: 'warn', icon: '↓' },
        { label: 'Inventory value', value: kpis.inventoryValue, sub: `${kpis.totalUnits} units on hand`, tone: 'brand', icon: '＄' },
        {
          label: 'Expiring / expired',
          value: String(kpis.expiringSoonUnits + kpis.expiredUnits),
          sub: kpis.expiredUnits > 0 ? `${kpis.expiredUnits} already expired` : `within ${kpis.expiringWithinDays} days`,
          tone: 'danger',
          icon: '⏳',
        },
      ]
    : []

  const products = data?.products ?? []
  const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageStart = safePage * PAGE_SIZE
  const pageProducts = products.slice(pageStart, pageStart + PAGE_SIZE)

  // Keep the page index valid if the product count shrinks.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1)
  }, [page, pageCount])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">Contoso Market</span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button key={item.label} className={`nav-item${item.active ? ' active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-card">
            <span className="avatar">PM</span>
            <div>
              <div className="user-name">Priya Menon</div>
              <div className="user-plan">Category Manager</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h1>Grocery Ops Hub</h1>
            <p>Supermarket categories — stock, demand and suppliers at a glance.</p>
          </div>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        <section className="kpi-row">
          {kpiCards.map((k) => (
            <div key={k.label} className={`kpi kpi-${k.tone}`}>
              <span className="kpi-icon" aria-hidden="true">{k.icon}</span>
              <div className="kpi-body">
                <span className="kpi-label">{k.label}</span>
                <span className="kpi-value">{k.value}</span>
                <span className="kpi-delta">{k.sub}</span>
              </div>
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div className="panel-title">Inventory</div>
            <span className="panel-meta">{(data?.products ?? []).length} SKUs · live</span>
          </div>
          <table className="data-table inv-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th className="ta-right">Unit price</th>
                <th className="ta-right">In stock</th>
                <th className="ta-right">Reorder at</th>
                <th className="ta-center">Sold (30 days)</th>
                <th className="ta-right">Inventory value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageProducts.map((p) => (
                <tr key={p.sku} className={`${p.low ? 'row-low' : ''}${changedSkus.has(p.sku) ? ' row-flash' : ''}`}>
                  <td className="mono sku-cell">{p.sku}</td>
                  <td>
                    <div className="prod-cell">
                      <span className="cat-dot" style={{ background: CAT_COLOR[p.category] ?? 'var(--text-tertiary)' }} title={p.category} />
                      <div className="prod-main">
                        <div className="prod-line">
                          <span className="prod-name">{p.name}</span>
                          {p.coldChain && <span className="chip-cold" title="Cold chain">❄</span>}
                          {p.complianceFlag && <span className="flag">compliance</span>}
                        </div>
                        <div className="prod-sub">{p.category}</div>
                      </div>
                    </div>
                  </td>
                  <td className="ta-right mono">{p.retail}</td>
                  <td className="ta-right">
                    <span className={`num-strong${p.low ? ' is-low' : ''}`}>{p.stock}</span>
                  </td>
                  <td className="ta-right muted mono">{p.reorderPoint}</td>
                  <td>
                    <div className="sales-cell">
                      <SalesGraph values={p.spark} tone={sparkTone(p.trendPct)} gid={`g-${p.sku}`} />
                      {p.trendPct != null && (
                        <span className={`spark-pct ${sparkTone(p.trendPct)}`}>
                          {p.trendPct > 0 ? '+' : ''}{p.trendPct}%
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="ta-right mono num-strong">{p.value}</td>
                  <td>{statusCell(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {products.length > PAGE_SIZE && (
            <div className="pagination">
              <span className="page-info">
                {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, products.length)} of {products.length}
              </span>
              <div className="page-controls">
                <button
                  className="page-btn"
                  onClick={() => setPage((v) => Math.max(0, v - 1))}
                  disabled={safePage === 0}
                  aria-label="Previous page"
                >
                  ‹ Prev
                </button>
                {Array.from({ length: pageCount }, (_, i) => (
                  <button
                    key={i}
                    className={`page-num${i === safePage ? ' active' : ''}`}
                    onClick={() => setPage(i)}
                    aria-label={`Page ${i + 1}`}
                    aria-current={i === safePage ? 'page' : undefined}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  className="page-btn"
                  onClick={() => setPage((v) => Math.min(pageCount - 1, v + 1))}
                  disabled={safePage === pageCount - 1}
                  aria-label="Next page"
                >
                  Next ›
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      <aside className="assistant-panel">
        <div className="assistant-header">
          <div className="assistant-id">
            <span className="assistant-avatar">R</span>
            <div>
              <div className="assistant-name">Remi</div>
              <div className="assistant-sub">Ops assistant · orchestrator</div>
            </div>
          </div>
          <span className="sdk-badge">Copilot SDK</span>
        </div>

        <div className="team-strip" title="Foundry hosted specialist agents">
          <div className="team-strip-label">
            <span>Specialist agents</span>
            <span className="team-foundry">Foundry hosted</span>
          </div>
          <div className="team-chips">
            {SPECIALISTS.map((s) => (
              <div key={s.name} className={`team-chip ${s.tone}`}>
                <span className="team-icon" aria-hidden="true">{s.icon}</span>
                <div className="team-meta">
                  <div className="team-name">
                    {s.name}
                    <span className="team-dot" title="active" aria-hidden="true" />
                  </div>
                  <div className="team-sub">{s.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {messages.length === 0 && (
          <div className="suggestions">
            <div className="suggestions-title">Try asking</div>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => sendMessage(s)} disabled={isLoading}>
                {s}
              </button>
            ))}
          </div>
        )}

        <ChatWindow messages={messages} isStreaming={isLoading} onQuickReply={sendMessage} />
        <MessageInput onSend={sendMessage} disabled={isLoading} />
      </aside>
    </div>
  )
}
