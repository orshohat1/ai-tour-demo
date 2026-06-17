// Custom Copilot SDK tools for the Contoso Market Supplements Ops Hub ("Remi").
//
// THIS is what the IDE Copilot fundamentally cannot do: call into *your*
// product's backend, take *real* business actions, and orchestrate a TEAM of
// governed production agents. Remi holds fast read/act tools and routes hard
// judgement to three Foundry hosted specialists (inventory, forecast, compliance).
//
// Defined with `defineTool` from @github/copilot-sdk. Handlers return
// JSON-serializable objects the model reads to compose its answer.

import { defineTool } from "@github/copilot-sdk";
import {
  adjustStock,
  createPurchaseOrder,
  findProduct,
  formatUsd,
  getLedger,
  getLots,
  getInventoryHealth,
  getProduct,
  getSalesHistory,
  getSupplier,
  listInventory,
  listLowStock,
  listProducts,
  listSuppliers,
  receiveStock,
  recordStockCount,
  setProductStatus,
  setReorderPolicy,
  writeOffExpired,
} from "../data/store.js";
import { consultSpecialist, type SpecialistRole } from "../foundry/specialist.js";
import { withToolSpan } from "../telemetry.js";

/** Friendly labels the UI shows per tool call. */
export const TOOL_LABELS: Record<string, string> = {
  lookup_product: "Looking up product",
  list_low_stock: "Scanning low stock",
  get_sales_history: "Reading sales history",
  list_suppliers: "Checking suppliers",
  inventory_overview: "Reading inventory health",
  view_stock_ledger: "Reading stock ledger",
  receive_stock: "Receiving stock",
  adjust_stock: "Adjusting stock",
  record_stock_count: "Reconciling cycle count",
  write_off_expired: "Writing off expired stock",
  set_reorder_policy: "Updating reorder policy",
  set_product_status: "Updating product status",
  create_purchase_order: "Creating purchase order",
  request_approval: "Requesting your approval",
  consult_inventory: "Consulting Inventory specialist",
  consult_forecast: "Consulting Demand-Forecast specialist",
  consult_supplier_compliance: "Consulting Supplier & Compliance specialist",
  consult_ops_review: "Running Ops Review (multi-agent workflow)",
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function productView(id: string) {
  const p = getProduct(id);
  if (!p) return null;
  const supplier = getSupplier(p.supplierId);
  const lots = getLots(p.id);
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    status: p.status,
    price: formatUsd(p.priceCents),
    unitCost: formatUsd(p.unitCostCents),
    stock: p.stock,
    reorderPoint: p.reorderPoint,
    parLevel: p.parLevel,
    belowReorderPoint: p.stock <= p.reorderPoint,
    suggestedReorderUnits: p.stock <= p.reorderPoint ? Math.max(0, p.parLevel - p.stock) : 0,
    inventoryValue: formatUsd(p.stock * p.unitCostCents),
    caseSize: p.caseSize,
    nearestExpiry: p.expiryDate,
    lots: lots.map((l) => ({ id: l.id, units: l.units, expiry: l.expiryDate })),
    coldChain: p.coldChain,
    markdownPct: p.markdownPct,
    supplier: supplier ? { id: supplier.id, name: supplier.name, leadTimeDays: supplier.leadTimeDays } : p.supplierId,
    complianceFlag: p.complianceFlag,
  };
}

const lookupProduct = defineTool("lookup_product", {
  description:
    "Look up a grocery product by SKU (e.g. SKU-1001), name, or brand. Returns stock, price, reorder point, expiry, supplier and any compliance flag. Use this to resolve which product the user means.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "SKU, product name, or brand" } },
    required: ["query"],
  },
  handler: async (args: Record<string, unknown>) => {
    const p = findProduct(asString(args.query));
    if (!p) return { found: false, message: `No product matched "${asString(args.query)}"` };
    return { found: true, ...productView(p.id)! };
  },
});

const listLowStockTool = defineTool("list_low_stock", {
  description:
    "List products at or below their reorder point, sorted by shortfall, flagging near-expiry items. Use this to find what needs restocking.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const items = listLowStock();
    return {
      count: items.length,
      items: items.map((i) => ({
        id: i.product.id,
        name: i.product.name,
        stock: i.product.stock,
        reorderPoint: i.product.reorderPoint,
        shortfall: i.shortfall,
        nearExpiry: i.nearExpiry,
        expiry: i.product.expiryDate,
      })),
    };
  },
});

const getSalesHistoryTool = defineTool("get_sales_history", {
  description:
    "Get recent weekly unit sales and the trend note for a product SKU. Use this to understand demand before forecasting or reordering.",
  parameters: {
    type: "object",
    properties: { productId: { type: "string", description: "Product SKU, e.g. SKU-1001" } },
    required: ["productId"],
  },
  handler: async (args: Record<string, unknown>) => {
    const h = getSalesHistory(asString(args.productId));
    if (!h) return { found: false, message: `No sales history for ${asString(args.productId)}` };
    return { found: true, productId: h.productId, weekly: h.weekly, trendNote: h.trendNote };
  },
});

const listSuppliersTool = defineTool("list_suppliers", {
  description: "List suppliers with lead time, reliability, and minimum order value.",
  parameters: { type: "object", properties: {} },
  handler: async () => ({
    suppliers: listSuppliers().map((s) => ({
      id: s.id,
      name: s.name,
      leadTimeDays: s.leadTimeDays,
      reliability: s.reliability,
      minimumOrder: formatUsd(s.minOrderCents),
    })),
  }),
});

const createPurchaseOrderTool = defineTool("create_purchase_order", {
  description:
    "Create a purchase order with a supplier. This takes a REAL action: it records the PO and, when submitted, receives the stock (increases on-hand units). All lines must be products supplied by the chosen supplier. Confirm quantities with the user before submitting.",
  parameters: {
    type: "object",
    properties: {
      supplierId: { type: "string", description: "Supplier id, e.g. SUP-A" },
      lines: {
        type: "array",
        description: "Order lines",
        items: {
          type: "object",
          properties: {
            productId: { type: "string", description: "Product SKU" },
            units: { type: "number", description: "Units to order (use case-size multiples)" },
          },
          required: ["productId", "units"],
        },
      },
      note: { type: "string", description: "Short note for the PO" },
      submit: { type: "boolean", description: "Submit now (receives stock) vs save as draft" },
    },
    required: ["supplierId", "lines"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan(
      "create_purchase_order",
      { supplierId: asString(args.supplierId), submit: args.submit === true },
      async () => {
        const rawLines = Array.isArray(args.lines) ? args.lines : [];
        const lines = rawLines.map((l) => ({
          productId: asString((l as Record<string, unknown>).productId),
          units: Number((l as Record<string, unknown>).units) || 0,
        }));
        const result = createPurchaseOrder({
          supplierId: asString(args.supplierId),
          lines,
          note: asString(args.note),
          submit: args.submit === true,
        });
        if (!result.ok) return { ok: false, error: result.error };
        const o = result.order!;
        return {
          ok: true,
          orderId: o.id,
          supplierId: o.supplierId,
          status: o.status,
          total: formatUsd(o.totalCents),
          belowSupplierMinimum: result.belowMinimum ?? false,
          lines: o.lines.map((l) => ({ productId: l.productId, units: l.units, unitCost: formatUsd(l.unitCostCents) })),
        };
      },
    );
  },
});

const inventoryOverviewTool = defineTool("inventory_overview", {
  description:
    "Get category-wide inventory health: total on-hand units and stock value, count of low-stock SKUs, compliance holds, units on clearance, and units expiring soon or already expired. Use this for 'how healthy is our inventory' or to find what needs attention.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const h = getInventoryHealth();
    const items = listInventory();
    return {
      activeSkus: h.activeSkus,
      lowStock: h.lowStock,
      complianceHolds: h.complianceHolds,
      onClearance: h.clearance,
      totalUnits: h.totalUnits,
      inventoryValue: formatUsd(h.totalValueCents),
      expiringSoon: { units: h.expiringSoonUnits, value: formatUsd(h.expiringSoonValueCents), withinDays: h.expiringWithinDays },
      expired: { units: h.expiredUnits, value: formatUsd(h.expiredValueCents) },
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        status: i.status,
        stock: i.stock,
        reorderPoint: i.reorderPoint,
        parLevel: i.parLevel,
        low: i.low,
        daysOfCover: i.daysOfCover,
        nearestExpiry: i.nearestExpiry,
        expiredUnits: i.expiredUnits,
        value: formatUsd(i.valueCents),
      })),
    };
  },
});

const viewStockLedgerTool = defineTool("view_stock_ledger", {
  description:
    "View the recent stock-movement ledger (audit trail of receipts, sales, adjustments, cycle counts and write-offs). Optionally filter by product SKU. Use this to explain how on-hand stock changed.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Optional product SKU to filter by" },
      limit: { type: "number", description: "Max entries to return (default 12)" },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const productId = args.productId ? asString(args.productId) : undefined;
    const limit = Number(args.limit) > 0 ? Math.min(50, Number(args.limit)) : 12;
    const entries = getLedger(productId, limit);
    return {
      count: entries.length,
      entries: entries.map((m) => ({
        id: m.id,
        productId: m.productId,
        when: m.ts,
        kind: m.kind,
        deltaUnits: m.deltaUnits,
        reason: m.reason,
        ref: m.refId,
        balanceAfter: m.balanceAfter,
        note: m.note,
      })),
    };
  },
});

const receiveStockTool = defineTool("receive_stock", {
  description:
    "Receive units into stock as a new lot (goods inward) — for ad-hoc deliveries or returns to stock. Takes a REAL action: increases on-hand units and records a ledger receipt. Provide an expiry date for perishable items.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product SKU" },
      units: { type: "number", description: "Units received (positive)" },
      expiryDate: { type: "string", description: "Lot expiry date, ISO YYYY-MM-DD (optional)" },
      note: { type: "string", description: "Short note (optional)" },
    },
    required: ["productId", "units"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("receive_stock", { productId: asString(args.productId) }, async () => {
      const result = receiveStock({
        productId: asString(args.productId),
        units: Number(args.units) || 0,
        expiryDate: args.expiryDate ? asString(args.expiryDate) : undefined,
        note: args.note ? asString(args.note) : undefined,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, product: result.product!.id, received: Number(args.units) || 0, newStock: result.product!.stock, lot: result.lot!.id, expiry: result.lot!.expiryDate };
    });
  },
});

const adjustStockTool = defineTool("adjust_stock", {
  description:
    "Adjust on-hand units with a reason code — for damage, shrinkage, theft, found stock, samples, or returns. Takes a REAL action: changes stock (negative removes FEFO, positive adds) and records a ledger adjustment. Confirm with the user before adjusting.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product SKU" },
      deltaUnits: { type: "number", description: "Signed change: negative to remove, positive to add" },
      reason: { type: "string", description: "One of: damage, shrinkage, theft, found, sample, return, correction" },
      note: { type: "string", description: "Short note (optional)" },
    },
    required: ["productId", "deltaUnits", "reason"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("adjust_stock", { productId: asString(args.productId), reason: asString(args.reason) }, async () => {
      const result = adjustStock({
        productId: asString(args.productId),
        deltaUnits: Number(args.deltaUnits) || 0,
        reason: asString(args.reason),
        note: args.note ? asString(args.note) : undefined,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, product: result.product!.id, deltaUnits: Number(args.deltaUnits) || 0, reason: asString(args.reason), newStock: result.product!.stock };
    });
  },
});

const recordStockCountTool = defineTool("record_stock_count", {
  description:
    "Reconcile a physical cycle count: set the counted on-hand quantity and the system corrects stock to match, recording the variance in the ledger. Use this after a shelf count.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product SKU" },
      countedUnits: { type: "number", description: "Units physically counted (zero or positive)" },
      note: { type: "string", description: "Short note (optional)" },
    },
    required: ["productId", "countedUnits"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("record_stock_count", { productId: asString(args.productId) }, async () => {
      const result = recordStockCount({
        productId: asString(args.productId),
        countedUnits: Number(args.countedUnits) || 0,
        note: args.note ? asString(args.note) : undefined,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, product: result.product!.id, counted: Number(args.countedUnits) || 0, variance: result.variance, newStock: result.product!.stock };
    });
  },
});

const writeOffExpiredTool = defineTool("write_off_expired", {
  description:
    "Write off (remove) expired stock lots. Takes a REAL action: removes expired units and records ledger write-offs with the value lost. Omit productId to sweep the whole category, or pass a SKU to target one product.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Optional product SKU; omit to write off across all products" },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("write_off_expired", { productId: args.productId ? asString(args.productId) : "all" }, async () => {
      const result = writeOffExpired({ productId: args.productId ? asString(args.productId) : undefined });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        totalUnits: result.totalUnits,
        valueWrittenOff: formatUsd(result.totalValueCents),
        removed: result.removed.map((r) => ({ productId: r.productId, name: r.name, units: r.units, value: formatUsd(r.valueCents) })),
      };
    });
  },
});

const setReorderPolicyTool = defineTool("set_reorder_policy", {
  description:
    "Update a product's reorder point and/or par (target) level. Use this to tune replenishment, e.g. raise the reorder point ahead of a demand spike.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product SKU" },
      reorderPoint: { type: "number", description: "New reorder point (optional)" },
      parLevel: { type: "number", description: "New par/target level (optional, must be >= reorder point)" },
    },
    required: ["productId"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("set_reorder_policy", { productId: asString(args.productId) }, async () => {
      const result = setReorderPolicy({
        productId: asString(args.productId),
        reorderPoint: args.reorderPoint !== undefined ? Number(args.reorderPoint) : undefined,
        parLevel: args.parLevel !== undefined ? Number(args.parLevel) : undefined,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, product: result.product!.id, reorderPoint: result.product!.reorderPoint, parLevel: result.product!.parLevel };
    });
  },
});

const setProductStatusTool = defineTool("set_product_status", {
  description:
    "Set a product's lifecycle status: 'active' (normal selling), 'clearance' (apply a markdown to move near-expiry stock), or 'hold' (stop selling/restocking, e.g. compliance). Use clearance to clear slow or near-expiry stock instead of writing it off.",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product SKU" },
      status: { type: "string", description: "One of: active, clearance, hold" },
      markdownPct: { type: "number", description: "Clearance markdown fraction 0.05–0.9 (only for clearance)" },
    },
    required: ["productId", "status"],
  },
  handler: async (args: Record<string, unknown>) => {
    return withToolSpan("set_product_status", { productId: asString(args.productId), status: asString(args.status) }, async () => {
      const result = setProductStatus({
        productId: asString(args.productId),
        status: asString(args.status) as "active" | "clearance" | "hold",
        markdownPct: args.markdownPct !== undefined ? Number(args.markdownPct) : undefined,
      });
      if (!result.ok) return { ok: false, error: result.error };
      const p = result.product!;
      return { ok: true, product: p.id, status: p.status, markdownPct: p.markdownPct ?? null };
    });
  },
});

const requestApprovalTool = defineTool("request_approval", {
  description:
    "Ask the human category manager to approve a consequential action BEFORE you take it. You MUST call this and then STOP — do not call the action tool in the same turn. Use it before submitting a purchase order, writing off stock, adjusting stock, recording a count, putting an item on clearance, or placing it on hold. The user will see Approve / Decline buttons and reply in their next message.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "Short title of what you want to do, e.g. 'Submit purchase order'" },
      detail: { type: "string", description: "Plain-English summary of exactly what will change (products, quantities, supplier, cost, units before to after)" },
    },
    required: ["action", "detail"],
  },
  handler: async (args: Record<string, unknown>) => {
    return {
      awaitingApproval: true,
      action: asString(args.action),
      detail: asString(args.detail),
      message:
        "Approval card shown to the human. STOP now and wait — do not take the action yet. Proceed only after they approve in their next message.",
    };
  },
});

/** Build a consult tool that routes to a specific Foundry specialist agent. */
function defineConsultTool(toolName: string, role: SpecialistRole, description: string) {
  return defineTool(toolName, {
    description,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The specific question for the specialist" },
        productIds: {
          type: "array",
          description: "Relevant product SKUs to include as context",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
    handler: async (args: Record<string, unknown>) => {
      return withToolSpan(`consult_${role}`, { role }, async () => {
        const ids = Array.isArray(args.productIds) ? args.productIds.map((x) => asString(x)) : [];
        const products = (ids.length ? ids.map((id) => getProduct(id)) : listProducts()).filter(
          (p): p is NonNullable<typeof p> => Boolean(p),
        );
        const answer = await consultSpecialist(role, { products, question: asString(args.question) });
        return {
          ok: true,
          specialist: answer.role,
          handledBy: answer.source === "fallback" ? `${role} specialist (local policy)` : "Foundry hosted agent",
          source: answer.source,
          recommendation: answer.recommendation,
          data: answer.data,
        };
      });
    },
  });
}

const consultInventory = defineConsultTool(
  "consult_inventory",
  "inventory",
  "Consult the Inventory specialist (a Foundry hosted agent) for stock health, expiry risk, and cold-chain handling. Pass the relevant product SKUs.",
);

const consultForecast = defineConsultTool(
  "consult_forecast",
  "forecast",
  "Consult the Demand-Forecast specialist (a Foundry hosted agent) to predict demand and recommend reorder quantities from sales history. Pass the relevant product SKUs.",
);

const consultSupplierCompliance = defineConsultTool(
  "consult_supplier_compliance",
  "compliance",
  "Consult the Supplier & Compliance specialist (a Foundry hosted agent) for best supplier choice and food-safety / product-recall checks. Use this before restocking anything with a compliance flag. Pass the relevant product SKUs.",
);

const consultOpsReview = defineConsultTool(
  "consult_ops_review",
  "ops",
  "Run a full Ops Review for a reorder decision. This calls a Foundry hosted MULTI-AGENT WORKFLOW: the demand-forecast and inventory specialists run in parallel, then a supplier & compliance gate makes the final go/no-go call (an active recall or compliance flag forces a HOLD). Use this for an end-to-end 'should we reorder this, and how much' decision instead of consulting the three specialists separately. Pass the relevant product SKUs.",
);

/** All custom tools exposed to the orchestrator session. */
export const customTools = [
  lookupProduct,
  listLowStockTool,
  getSalesHistoryTool,
  listSuppliersTool,
  inventoryOverviewTool,
  viewStockLedgerTool,
  receiveStockTool,
  adjustStockTool,
  recordStockCountTool,
  writeOffExpiredTool,
  setReorderPolicyTool,
  setProductStatusTool,
  createPurchaseOrderTool,
  requestApprovalTool,
  consultInventory,
  consultForecast,
  consultSupplierCompliance,
  consultOpsReview,
];
