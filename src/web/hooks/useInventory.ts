import { useCallback, useEffect, useState } from 'react'

export interface InventoryProduct {
  sku: string
  name: string
  brand: string
  category: string
  status: 'active' | 'clearance' | 'hold'
  coldChain: boolean
  stock: number
  reorderPoint: number
  parLevel: number
  low: boolean
  unitCost: string
  retail: string
  value: string
  valueCents: number
  weeklyVelocity: number
  daysOfCover: number | null
  nearestExpiry: string
  daysToExpiry: number
  nearExpiry: boolean
  lots: number
  expiredUnits: number
  markdownPct: number | null
  complianceFlag: string | null
  spark: number[]
  trendPct: number | null
}

export interface InventoryKpis {
  activeSkus: number
  lowStock: number
  complianceHolds: number
  onClearance: number
  totalUnits: number
  inventoryValue: string
  inventoryValueCents: number
  expiringSoonUnits: number
  expiringSoonValue: string
  expiredUnits: number
  expiredValue: string
  expiringWithinDays: number
}

export type AlertKind = 'flagged' | 'expiry' | 'expired' | 'low' | 'clearance'
export interface InventoryAlert {
  sku: string
  desc: string
  kind: AlertKind
}

export interface LedgerEntry {
  id: string
  sku: string
  when: string
  kind: 'receipt' | 'sale' | 'adjustment' | 'write-off' | 'count'
  deltaUnits: number
  reason?: string
  ref?: string
  balanceAfter: number
  note?: string
}

export interface InventorySnapshot {
  kpis: InventoryKpis
  products: InventoryProduct[]
  alerts: InventoryAlert[]
  ledger: LedgerEntry[]
}

/**
 * Fetches the live inventory snapshot from the API. Exposes `refresh()` so the
 * dashboard can re-pull after the assistant takes an action — this is what makes
 * the board visibly update as Remi manages inventory.
 */
export function useInventory() {
  const [data, setData] = useState<InventorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changedSkus, setChangedSkus] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/inventory')
      if (!res.ok) throw new Error(`Inventory ${res.status}`)
      const next = (await res.json()) as InventorySnapshot
      setData((prev) => {
        if (prev) {
          const changed = new Set<string>()
          const prevBySku = new Map(prev.products.map((p) => [p.sku, p]))
          for (const p of next.products) {
            const before = prevBySku.get(p.sku)
            if (before && (before.stock !== p.stock || before.status !== p.status)) changed.add(p.sku)
          }
          if (changed.size > 0) {
            setChangedSkus(changed)
            setTimeout(() => setChangedSkus(new Set()), 2200)
          }
        }
        return next
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inventory')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { data, error, refresh, changedSkus }
}
