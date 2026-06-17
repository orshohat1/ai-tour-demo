import { Router } from "express";
import {
  formatUsd,
  getInventoryHealth,
  getLedger,
  getSalesHistory,
  listInventory,
  type InventoryView,
  type StockMovement,
} from "../data/store.js";

const router = Router();

/** Recent weekly sales series + week-over-week trend for a product. */
function salesSpark(productId: string): { spark: number[]; trendPct: number | null } {
  const h = getSalesHistory(productId);
  if (!h || h.weekly.length === 0) return { spark: [], trendPct: null };
  const spark = h.weekly.slice(-6).map((w) => w.units);
  const first = spark[0];
  const last = spark[spark.length - 1];
  const trendPct = first > 0 ? Math.round(((last - first) / first) * 100) : null;
  return { spark, trendPct };
}

/** Build the alert feed the dashboard shows, derived from current state. */
function buildAlerts(items: InventoryView[]) {
  const alerts: Array<{ sku: string; desc: string; kind: "flagged" | "expiry" | "expired" | "low" | "clearance" }> = [];
  for (const i of items) {
    if (i.complianceFlag) {
      alerts.push({ sku: i.id, desc: `${i.name} — compliance review required`, kind: "flagged" });
    }
    if (i.expiredUnits > 0) {
      alerts.push({ sku: i.id, desc: `${i.name} — ${i.expiredUnits} expired unit(s) to write off`, kind: "expired" });
    } else if (i.nearExpiry) {
      alerts.push({ sku: i.id, desc: `${i.name} — nearest lot expires ${i.nearestExpiry}`, kind: "expiry" });
    }
    if (i.low && i.status !== "hold") {
      alerts.push({ sku: i.id, desc: `${i.name} — ${i.stock} on hand, at/below reorder point ${i.reorderPoint}`, kind: "low" });
    }
    if (i.status === "clearance") {
      const pct = i.markdownPct ? Math.round(i.markdownPct * 100) : 0;
      alerts.push({ sku: i.id, desc: `${i.name} — on clearance (-${pct}%)`, kind: "clearance" });
    }
  }
  // Compliance first, then expired, expiry, low, clearance.
  const order = { flagged: 0, expired: 1, expiry: 2, low: 3, clearance: 4 };
  return alerts.sort((a, b) => order[a.kind] - order[b.kind]);
}

function ledgerView(m: StockMovement) {
  return {
    id: m.id,
    sku: m.productId,
    when: m.ts,
    kind: m.kind,
    deltaUnits: m.deltaUnits,
    reason: m.reason,
    ref: m.refId,
    balanceAfter: m.balanceAfter,
    note: m.note,
  };
}

// Live snapshot of the inventory backend for the dashboard. Read-only.
router.get("/inventory", (_req, res) => {
  const items = listInventory();
  const h = getInventoryHealth();
  res.json({
    kpis: {
      activeSkus: h.activeSkus,
      lowStock: h.lowStock,
      complianceHolds: h.complianceHolds,
      onClearance: h.clearance,
      totalUnits: h.totalUnits,
      inventoryValue: formatUsd(h.totalValueCents),
      inventoryValueCents: h.totalValueCents,
      expiringSoonUnits: h.expiringSoonUnits,
      expiringSoonValue: formatUsd(h.expiringSoonValueCents),
      expiredUnits: h.expiredUnits,
      expiredValue: formatUsd(h.expiredValueCents),
      expiringWithinDays: h.expiringWithinDays,
    },
    products: items.map((i) => {
      const { spark, trendPct } = salesSpark(i.id);
      return {
        sku: i.id,
        name: i.name,
        brand: i.brand,
        category: i.category,
        status: i.status,
        coldChain: i.coldChain,
        stock: i.stock,
        reorderPoint: i.reorderPoint,
        parLevel: i.parLevel,
        low: i.low,
        unitCost: formatUsd(i.unitCostCents),
        retail: formatUsd(i.retailCents),
        value: formatUsd(i.valueCents),
        valueCents: i.valueCents,
        weeklyVelocity: i.weeklyVelocity,
        daysOfCover: i.daysOfCover,
        nearestExpiry: i.nearestExpiry,
        daysToExpiry: i.daysToExpiry,
        nearExpiry: i.nearExpiry,
        lots: i.lots,
        expiredUnits: i.expiredUnits,
        markdownPct: i.markdownPct ?? null,
        complianceFlag: i.complianceFlag ?? null,
        spark,
        trendPct,
      };
    }),
    alerts: buildAlerts(items),
    ledger: getLedger(undefined, 14).map(ledgerView),
  });
});

export default router;
