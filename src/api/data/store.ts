// Contoso Market — Supplements Ops Hub: seeded in-memory backend.
//
// This is the "real system" the in-app orchestrator (Remi) acts on through
// custom Copilot SDK tools, and that the Foundry specialist agents reason over.
// It models a supermarket's health-supplements category: products, stock,
// suppliers, sales history, and purchase orders.
//
// Deterministic and resettable so the recorded demo is identical on every take.
// A production app would back these with a real ERP / inventory database.

export type Category =
  | "Produce"
  | "Dairy & Eggs"
  | "Beverages"
  | "Pantry"
  | "Snacks"
  | "Frozen"
  | "Household";

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: Category;
  /** Retail price in minor units (cents). */
  priceCents: number;
  /** Units currently on hand (sum of open lots). Maintained by stock movements. */
  stock: number;
  /** Reorder when stock drops to/below this. */
  reorderPoint: number;
  /** Target level to replenish up to when reordering. */
  parLevel: number;
  /** Case/pack size used for purchase orders. */
  caseSize: number;
  /** Current weighted-average wholesale unit cost in cents. */
  unitCostCents: number;
  /** Nearest lot expiry (ISO date). Maintained from lots. */
  expiryDate: string;
  /** Requires refrigerated handling. */
  coldChain: boolean;
  supplierId: string;
  /** Lifecycle status: active selling, on clearance markdown, or compliance hold. */
  status: ProductStatus;
  /** Markdown fraction (0..1) applied while on clearance. */
  markdownPct?: number;
  /** Optional regulatory/compliance note the Supplier & Compliance agent reviews. */
  complianceFlag?: string;
}

/** Lifecycle status of a product. */
export type ProductStatus = "active" | "clearance" | "hold";

/** A physical batch of stock with its own expiry and cost (enables FEFO). */
export interface StockLot {
  id: string;
  productId: string;
  units: number;
  /** ISO date this lot expires. */
  expiryDate: string;
  /** Wholesale unit cost for this lot, in cents. */
  unitCostCents: number;
  /** ISO timestamp the lot was received. */
  receivedAt: string;
}

export type MovementKind = "receipt" | "sale" | "adjustment" | "write-off" | "count";

/** An append-only stock-ledger entry — the audit trail for every change. */
export interface StockMovement {
  id: string;
  productId: string;
  /** ISO timestamp. */
  ts: string;
  kind: MovementKind;
  /** Signed change in units (+receipt, -sale/write-off, +/- adjustment/count). */
  deltaUnits: number;
  /** Reason code for adjustments/counts/write-offs. */
  reason?: string;
  /** Reference, e.g. a purchase order id. */
  refId?: string;
  /** On-hand units after this movement. */
  balanceAfter: number;
  note?: string;
}

export interface Supplier {
  id: string;
  name: string;
  leadTimeDays: number;
  /** 0..1 on-time delivery reliability. */
  reliability: number;
  /** Minimum order value in cents to avoid a small-order fee. */
  minOrderCents: number;
}

export interface SalesPoint {
  /** ISO week label, e.g. "2026-W21". */
  week: string;
  units: number;
}

export interface SalesHistory {
  productId: string;
  /** Most recent weeks last. */
  weekly: SalesPoint[];
  /** Human note on seasonality / promotions. */
  trendNote: string;
}

export type PurchaseOrderStatus = "draft" | "submitted";

export interface PurchaseOrderLine {
  productId: string;
  units: number;
  unitCostCents: number;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  lines: PurchaseOrderLine[];
  totalCents: number;
  status: PurchaseOrderStatus;
  note: string;
  createdAt: string;
}

interface StoreState {
  products: Map<string, Product>;
  suppliers: Map<string, Supplier>;
  sales: Map<string, SalesHistory>;
  /** Physical stock lots per product (FEFO order: earliest expiry first). */
  lots: Map<string, StockLot[]>;
  /** Append-only stock-movement ledger. */
  movements: StockMovement[];
  purchaseOrders: PurchaseOrder[];
  counters: { po: number; lot: number; mov: number };
}

/** Fixed "now" so the recorded demo's expiry/cover math is identical each run. */
export const ASOF = new Date("2026-06-16T00:00:00Z");
const DEFAULT_SHELF_LIFE_MONTHS = 18;

/** Add whole months to a date and return an ISO date (YYYY-MM-DD). */
function addMonthsIso(from: Date, months: number): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Recompute a product's derived stock, nearest expiry and avg cost from lots. */
function recompute(st: StoreState, productId: string): void {
  const product = st.products.get(productId);
  if (!product) return;
  const lots = (st.lots.get(productId) ?? []).filter((l) => l.units > 0);
  lots.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  st.lots.set(productId, lots);
  const totalUnits = lots.reduce((n, l) => n + l.units, 0);
  product.stock = totalUnits;
  if (lots.length > 0) {
    product.expiryDate = lots[0].expiryDate;
    const totalCost = lots.reduce((n, l) => n + l.units * l.unitCostCents, 0);
    if (totalUnits > 0) product.unitCostCents = Math.round(totalCost / totalUnits);
  }
}

interface ProductSeed {
  product: Omit<Product, "stock" | "expiryDate">;
  lots: Array<{ units: number; expiryDate: string; receivedAt: string }>;
}

function seed(): StoreState {
  const suppliers = new Map<string, Supplier>();
  for (const s of [
    { id: "SUP-A", name: "City Wholesale Foods", leadTimeDays: 7, reliability: 0.97, minOrderCents: 50_000 },
    { id: "SUP-B", name: "FreshLine Distributors", leadTimeDays: 14, reliability: 0.92, minOrderCents: 75_000 },
    { id: "SUP-C", name: "Valley Grocery Supply", leadTimeDays: 21, reliability: 0.85, minOrderCents: 40_000 },
  ] as Supplier[]) {
    suppliers.set(s.id, s);
  }

  // Each product is seeded with one or more physical lots. Expired lots on the
  // perishable items (strawberries, Greek yogurt) make write-off / FEFO real.
  const seeds: ProductSeed[] = [
    {
      product: {
        id: "SKU-1001", name: "Spring Water 24-pack (500ml)", brand: "ClearSprings",
        category: "Beverages", priceCents: 4_49, reorderPoint: 20, parLevel: 60, caseSize: 24,
        unitCostCents: 2_70, coldChain: false, supplierId: "SUP-A", status: "active",
      },
      lots: [{ units: 8, expiryDate: "2027-06-30", receivedAt: "2026-05-20T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1002", name: "Jasmine Rice 5 lb Bag", brand: "GoldenField",
        category: "Pantry", priceCents: 8_99, reorderPoint: 50, parLevel: 160, caseSize: 12,
        unitCostCents: 5_40, coldChain: false, supplierId: "SUP-B", status: "active",
      },
      lots: [{ units: 140, expiryDate: "2027-12-31", receivedAt: "2026-04-10T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1003", name: "Strawberries 1 lb Clamshell", brand: "BerryFresh",
        category: "Produce", priceCents: 4_99, reorderPoint: 25, parLevel: 60, caseSize: 12,
        unitCostCents: 3_00, coldChain: true, supplierId: "SUP-A", status: "active",
      },
      lots: [
        { units: 2, expiryDate: "2026-06-22", receivedAt: "2026-06-14T09:00:00Z" },
        { units: 3, expiryDate: "2026-06-08", receivedAt: "2026-06-01T09:00:00Z" }, // EXPIRED
      ],
    },
    {
      product: {
        id: "SKU-1004", name: "Potato Chips Family Size (10 oz)", brand: "CrispCo",
        category: "Snacks", priceCents: 3_99, reorderPoint: 30, parLevel: 90, caseSize: 12,
        unitCostCents: 2_40, coldChain: false, supplierId: "SUP-C", status: "active",
      },
      lots: [{ units: 60, expiryDate: "2026-11-30", receivedAt: "2026-04-22T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1005", name: "Greek Yogurt 32 oz Tub", brand: "MeadowGold",
        category: "Dairy & Eggs", priceCents: 5_49, reorderPoint: 20, parLevel: 60, caseSize: 12,
        unitCostCents: 3_30, coldChain: true, supplierId: "SUP-B", status: "active",
      },
      lots: [
        { units: 15, expiryDate: "2026-07-10", receivedAt: "2026-06-10T09:00:00Z" },
        { units: 3, expiryDate: "2026-06-12", receivedAt: "2026-05-28T09:00:00Z" }, // EXPIRED
      ],
    },
    {
      product: {
        id: "SKU-1006", name: "Surge Energy Drink 4-pack (16 oz)", brand: "VoltLab",
        category: "Beverages", priceCents: 9_99, reorderPoint: 15, parLevel: 45, caseSize: 12,
        unitCostCents: 6_00, coldChain: false, supplierId: "SUP-C", status: "hold",
        complianceFlag:
          "Subject to an active supplier recall (caffeine above the permitted limit plus an unapproved additive). Do not restock until the recall is cleared.",
      },
      lots: [{ units: 30, expiryDate: "2026-12-31", receivedAt: "2026-05-02T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1007", name: "Pasta Sauce Marinara 24 oz Jar", brand: "Nonna's",
        category: "Pantry", priceCents: 3_49, reorderPoint: 30, parLevel: 90, caseSize: 12,
        unitCostCents: 2_10, coldChain: false, supplierId: "SUP-A", status: "active",
      },
      lots: [{ units: 96, expiryDate: "2027-05-31", receivedAt: "2026-04-30T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1008", name: "Peanut Butter Creamy 16 oz", brand: "NuttyBros",
        category: "Pantry", priceCents: 4_29, reorderPoint: 25, parLevel: 80, caseSize: 12,
        unitCostCents: 2_60, coldChain: false, supplierId: "SUP-B", status: "active",
      },
      lots: [{ units: 22, expiryDate: "2027-08-31", receivedAt: "2026-05-12T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1009", name: "Breakfast Cereal Honey Oats 18 oz", brand: "MorningField",
        category: "Pantry", priceCents: 4_79, reorderPoint: 25, parLevel: 75, caseSize: 12,
        unitCostCents: 2_90, coldChain: false, supplierId: "SUP-C", status: "active",
      },
      lots: [{ units: 70, expiryDate: "2027-03-31", receivedAt: "2026-05-05T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1010", name: "Iced Tea 6-pack (16.9 oz)", brand: "SouthernLeaf",
        category: "Beverages", priceCents: 5_99, reorderPoint: 20, parLevel: 70, caseSize: 12,
        unitCostCents: 3_60, coldChain: false, supplierId: "SUP-B", status: "active",
      },
      lots: [{ units: 18, expiryDate: "2027-01-31", receivedAt: "2026-05-18T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1011", name: "Paper Towels 6 Mega Rolls", brand: "SoftNest",
        category: "Household", priceCents: 11_99, reorderPoint: 30, parLevel: 100, caseSize: 8,
        unitCostCents: 7_20, coldChain: false, supplierId: "SUP-A", status: "active",
      },
      lots: [{ units: 110, expiryDate: "2030-12-31", receivedAt: "2026-04-28T09:00:00Z" }],
    },
    {
      product: {
        id: "SKU-1012", name: "Frozen Cheese Pizza 12\"", brand: "ForniHouse",
        category: "Frozen", priceCents: 6_49, reorderPoint: 15, parLevel: 50, caseSize: 6,
        unitCostCents: 3_90, coldChain: true, supplierId: "SUP-C", status: "clearance", markdownPct: 0.2,
      },
      lots: [
        { units: 9, expiryDate: "2026-08-15", receivedAt: "2026-02-15T09:00:00Z" }, // near expiry
      ],
    },
  ];

  const products = new Map<string, Product>();
  const lots = new Map<string, StockLot[]>();
  const movements: StockMovement[] = [];
  const counters = { po: 4200, lot: 0, mov: 0 };

  for (const s of seeds) {
    const productLots: StockLot[] = s.lots.map((l) => ({
      id: `LOT-${++counters.lot}`,
      productId: s.product.id,
      units: l.units,
      expiryDate: l.expiryDate,
      unitCostCents: s.product.unitCostCents,
      receivedAt: l.receivedAt,
    }));
    lots.set(s.product.id, productLots);
    products.set(s.product.id, { ...s.product, stock: 0, expiryDate: "2027-01-01" });
  }

  // Weekly unit sales (most recent last). The forecast agent reasons over these.
  const sales = new Map<string, SalesHistory>();
  const salesSeed: SalesHistory[] = [
    {
      productId: "SKU-1001",
      weekly: weeks([14, 16, 19, 23, 28, 34]), // rising
      trendNote: "Rising ~20%/wk with the summer heatwave driving bottled-water demand.",
    },
    {
      productId: "SKU-1002",
      weekly: weeks([60, 58, 62, 59, 61, 60]),
      trendNote: "Flat, dependable staple. No promotions scheduled.",
    },
    {
      productId: "SKU-1003",
      weekly: weeks([22, 20, 19, 18, 17, 16]), // declining
      trendNote: "Softening as local strawberry season peaks and prices drop elsewhere. Highly perishable.",
    },
    {
      productId: "SKU-1004",
      weekly: weeks([12, 13, 14, 12, 15, 14]),
      trendNote: "Stable with a mild lift from weekend snacking.",
    },
    {
      productId: "SKU-1005",
      weekly: weeks([9, 11, 12, 14, 16, 19]), // rising
      trendNote: "Rising on the high-protein trend. Cold-chain item — watch handling on larger orders.",
    },
    {
      productId: "SKU-1006",
      weekly: weeks([20, 22, 21, 23, 22, 24]),
      trendNote: "Steady, but under an active recall — review before any restock.",
    },
    {
      productId: "SKU-1007",
      weekly: weeks([30, 34, 41, 48, 55, 63]), // strong rise
      trendNote: "Climbing fast with a pasta-night promo running in-store.",
    },
    {
      productId: "SKU-1008",
      weekly: weeks([18, 19, 21, 20, 23, 25]),
      trendNote: "Steady growth — back-to-school lunchbox staple.",
    },
    {
      productId: "SKU-1009",
      weekly: weeks([16, 15, 14, 14, 13, 12]), // soft decline
      trendNote: "Drifting down as shoppers switch to a competing cereal brand.",
    },
    {
      productId: "SKU-1010",
      weekly: weeks([10, 13, 17, 22, 28, 33]), // summer surge
      trendNote: "Summer iced-tea surge — watch stock, reorder point is close.",
    },
    {
      productId: "SKU-1011",
      weekly: weeks([40, 38, 41, 39, 42, 40]),
      trendNote: "Flat, dependable everyday seller.",
    },
    {
      productId: "SKU-1012",
      weekly: weeks([14, 12, 10, 8, 7, 5]), // declining, on clearance
      trendNote: "Declining; placed on clearance to clear near-expiry stock.",
    },
  ];
  for (const s of salesSeed) sales.set(s.productId, s);

  const st: StoreState = { products, suppliers, sales, lots, movements, purchaseOrders: [], counters };

  // Seed the ledger with the receipts that produced today's on-hand, then
  // recompute each product's derived stock / nearest-expiry / average cost.
  for (const product of products.values()) {
    const productLots = [...(lots.get(product.id) ?? [])].sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    let balance = 0;
    for (const lot of productLots) {
      balance += lot.units;
      movements.push({
        id: `MV-${++counters.mov}`,
        productId: product.id,
        ts: lot.receivedAt,
        kind: "receipt",
        deltaUnits: lot.units,
        refId: lot.id,
        balanceAfter: balance,
        note: "Opening receipt",
      });
    }
    recompute(st, product.id);
  }
  movements.sort((a, b) => a.ts.localeCompare(b.ts));

  return st;
}

/** Build weekly sales points ending around the current week (2026-W24). */
function weeks(units: number[]): SalesPoint[] {
  const startWeek = 25 - units.length;
  return units.map((u, i) => ({ week: `2026-W${String(startWeek + i).padStart(2, "0")}`, units: u }));
}

let state: StoreState = seed();

/** Reset the store to its seeded state. Used between recording takes. */
export function resetStore(): void {
  state = seed();
}

export function findProduct(query: string): Product | undefined {
  const q = query.trim().toLowerCase();
  const byId = state.products.get(query.trim().toUpperCase());
  if (byId) return byId;
  for (const p of state.products.values()) {
    const hay = `${p.name} ${p.brand} ${p.category}`.toLowerCase();
    if (hay.includes(q)) return p;
  }
  return undefined;
}

export function getProduct(productId: string): Product | undefined {
  return state.products.get(productId.trim().toUpperCase());
}

export function listProducts(): Product[] {
  return [...state.products.values()];
}

export function getSupplier(supplierId: string): Supplier | undefined {
  return state.suppliers.get(supplierId.trim().toUpperCase());
}

export function listSuppliers(): Supplier[] {
  return [...state.suppliers.values()];
}

export function getSalesHistory(productId: string): SalesHistory | undefined {
  return state.sales.get(productId.trim().toUpperCase());
}

// ── Stock ledger & lots ─────────────────────────────────────────────────────

/** Lots for a product (FEFO order: earliest expiry first). */
export function getLots(productId: string): StockLot[] {
  return state.lots.get(productId.trim().toUpperCase()) ?? [];
}

/** Recent stock-ledger movements, newest first. Optionally for one product. */
export function getLedger(productId?: string, limit = 20): StockMovement[] {
  let m = state.movements;
  if (productId) {
    const id = productId.trim().toUpperCase();
    m = m.filter((x) => x.productId === id);
  }
  return m
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

function daysUntil(dateIso: string, asOf = ASOF): number {
  return Math.round((new Date(dateIso).getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24));
}

/** Average weekly unit sales over the most recent (up to 3) weeks. */
function weeklyVelocity(productId: string): number {
  const h = state.sales.get(productId);
  if (!h || h.weekly.length === 0) return 0;
  const last = h.weekly.slice(-3);
  return last.reduce((n, p) => n + p.units, 0) / last.length;
}

/** Append a ledger entry. Call AFTER recompute so balanceAfter is correct. */
function pushMovement(
  kind: MovementKind,
  productId: string,
  deltaUnits: number,
  extra: { reason?: string; refId?: string; note?: string } = {},
): StockMovement {
  const product = state.products.get(productId);
  const mv: StockMovement = {
    id: `MV-${++state.counters.mov}`,
    productId,
    ts: new Date().toISOString(),
    kind,
    deltaUnits,
    reason: extra.reason,
    refId: extra.refId,
    balanceAfter: product?.stock ?? 0,
    note: extra.note,
  };
  state.movements.push(mv);
  return mv;
}

/** Remove `units` from a product's lots, earliest expiry first (FEFO). */
function consumeFEFO(productId: string, units: number): { consumed: number; costCents: number } {
  const lots = (state.lots.get(productId) ?? []).slice().sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  let remaining = units;
  let consumed = 0;
  let costCents = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.units, remaining);
    lot.units -= take;
    remaining -= take;
    consumed += take;
    costCents += take * lot.unitCostCents;
  }
  recompute(state, productId);
  return { consumed, costCents };
}

/** Add `units` as a new lot, or onto the latest-expiry lot when no expiry given. */
function addUnits(
  productId: string,
  units: number,
  opts: { unitCostCents?: number; expiryDate?: string } = {},
): StockLot {
  const product = state.products.get(productId)!;
  const lots = state.lots.get(productId) ?? [];
  state.lots.set(productId, lots);
  if (opts.expiryDate) {
    const lot: StockLot = {
      id: `LOT-${++state.counters.lot}`,
      productId,
      units,
      expiryDate: opts.expiryDate,
      unitCostCents: opts.unitCostCents ?? product.unitCostCents,
      receivedAt: new Date().toISOString(),
    };
    lots.push(lot);
    recompute(state, productId);
    return lot;
  }
  const latest = lots.slice().sort((a, b) => b.expiryDate.localeCompare(a.expiryDate))[0];
  if (latest) {
    latest.units += units;
    recompute(state, productId);
    return latest;
  }
  const lot: StockLot = {
    id: `LOT-${++state.counters.lot}`,
    productId,
    units,
    expiryDate: addMonthsIso(ASOF, DEFAULT_SHELF_LIFE_MONTHS),
    unitCostCents: opts.unitCostCents ?? product.unitCostCents,
    receivedAt: new Date().toISOString(),
  };
  lots.push(lot);
  recompute(state, productId);
  return lot;
}

// ── Inventory management operations (mutations Remi can perform) ─────────────

export interface ReceiveStockInput {
  productId: string;
  units: number;
  unitCostCents?: number;
  expiryDate?: string;
  refId?: string;
  note?: string;
}
export interface ReceiveStockResult {
  ok: boolean;
  error?: string;
  product?: Product;
  lot?: StockLot;
  movement?: StockMovement;
}

/** Receive units into stock as a new lot (goods inward). */
export function receiveStock(input: ReceiveStockInput): ReceiveStockResult {
  const product = getProduct(input.productId);
  if (!product) return { ok: false, error: `Product ${input.productId} not found` };
  if (!(input.units > 0)) return { ok: false, error: "Units to receive must be positive" };
  const expiryDate = input.expiryDate ?? addMonthsIso(ASOF, DEFAULT_SHELF_LIFE_MONTHS);
  const lot = addUnits(product.id, Math.round(input.units), {
    unitCostCents: input.unitCostCents,
    expiryDate,
  });
  const movement = pushMovement("receipt", product.id, Math.round(input.units), {
    refId: input.refId,
    note: input.note ?? "Stock received",
  });
  return { ok: true, product, lot, movement };
}

export const ADJUST_REASONS = ["damage", "shrinkage", "theft", "found", "sample", "return", "correction"] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export interface AdjustStockInput {
  productId: string;
  deltaUnits: number;
  reason: string;
  note?: string;
}
export interface AdjustStockResult {
  ok: boolean;
  error?: string;
  product?: Product;
  movement?: StockMovement;
}

/** Manually correct on-hand with a reason code (damage, shrinkage, found…). */
export function adjustStock(input: AdjustStockInput): AdjustStockResult {
  const product = getProduct(input.productId);
  if (!product) return { ok: false, error: `Product ${input.productId} not found` };
  const delta = Math.round(input.deltaUnits);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: "deltaUnits must be a non-zero number" };
  }
  const reason = (input.reason || "correction").toLowerCase();
  if (delta < 0) {
    const need = -delta;
    if (need > product.stock) {
      return { ok: false, error: `Cannot remove ${need} units; only ${product.stock} on hand` };
    }
    consumeFEFO(product.id, need);
  } else {
    addUnits(product.id, delta, {});
  }
  const movement = pushMovement("adjustment", product.id, delta, { reason, note: input.note });
  return { ok: true, product, movement };
}

export interface RecordStockCountInput {
  productId: string;
  countedUnits: number;
  note?: string;
}
export interface RecordStockCountResult {
  ok: boolean;
  error?: string;
  product?: Product;
  variance?: number;
  movement?: StockMovement;
}

/** Reconcile a physical cycle count: correct on-hand to the counted quantity. */
export function recordStockCount(input: RecordStockCountInput): RecordStockCountResult {
  const product = getProduct(input.productId);
  if (!product) return { ok: false, error: `Product ${input.productId} not found` };
  const counted = Math.round(input.countedUnits);
  if (!(counted >= 0)) return { ok: false, error: "countedUnits must be zero or positive" };
  const variance = counted - product.stock;
  if (variance < 0) consumeFEFO(product.id, -variance);
  else if (variance > 0) addUnits(product.id, variance, {});
  const movement = pushMovement("count", product.id, variance, {
    reason: "cycle-count",
    note: input.note ?? `Counted ${counted}`,
  });
  return { ok: true, product, variance, movement };
}

export interface WriteOffExpiredInput {
  productId?: string;
  asOf?: Date;
}
export interface WriteOffExpiredResult {
  ok: boolean;
  error?: string;
  removed: Array<{ productId: string; name: string; units: number; valueCents: number }>;
  totalUnits: number;
  totalValueCents: number;
}

/** Write off (remove) all lots whose expiry is on/before the cutoff date. */
export function writeOffExpired(input: WriteOffExpiredInput = {}): WriteOffExpiredResult {
  const asOf = input.asOf ?? ASOF;
  const cutoff = asOf.toISOString().slice(0, 10);
  const targets = input.productId
    ? ([getProduct(input.productId)].filter(Boolean) as Product[])
    : [...state.products.values()];
  if (input.productId && targets.length === 0) {
    return { ok: false, error: `Product ${input.productId} not found`, removed: [], totalUnits: 0, totalValueCents: 0 };
  }
  const removed: WriteOffExpiredResult["removed"] = [];
  let totalUnits = 0;
  let totalValueCents = 0;
  for (const product of targets) {
    const lots = state.lots.get(product.id) ?? [];
    let units = 0;
    let value = 0;
    for (const lot of lots) {
      if (lot.expiryDate <= cutoff && lot.units > 0) {
        units += lot.units;
        value += lot.units * lot.unitCostCents;
        lot.units = 0;
      }
    }
    if (units > 0) {
      recompute(state, product.id);
      pushMovement("write-off", product.id, -units, { reason: "expired", note: `Expired on/before ${cutoff}` });
      removed.push({ productId: product.id, name: product.name, units, valueCents: value });
      totalUnits += units;
      totalValueCents += value;
    }
  }
  return { ok: true, removed, totalUnits, totalValueCents };
}

export interface SetReorderPolicyInput {
  productId: string;
  reorderPoint?: number;
  parLevel?: number;
}
export interface SetReorderPolicyResult {
  ok: boolean;
  error?: string;
  product?: Product;
}

/** Update a product's reorder point and/or par (target) level. */
export function setReorderPolicy(input: SetReorderPolicyInput): SetReorderPolicyResult {
  const product = getProduct(input.productId);
  if (!product) return { ok: false, error: `Product ${input.productId} not found` };
  const reorderPoint = input.reorderPoint ?? product.reorderPoint;
  const parLevel = input.parLevel ?? product.parLevel;
  if (reorderPoint < 0 || parLevel < 0) return { ok: false, error: "Levels must be zero or positive" };
  if (parLevel < reorderPoint) return { ok: false, error: "parLevel must be greater than or equal to reorderPoint" };
  product.reorderPoint = Math.round(reorderPoint);
  product.parLevel = Math.round(parLevel);
  return { ok: true, product };
}

export interface SetProductStatusInput {
  productId: string;
  status: ProductStatus;
  markdownPct?: number;
}
export interface SetProductStatusResult {
  ok: boolean;
  error?: string;
  product?: Product;
}

/** Change a product's lifecycle status (active / clearance / hold). */
export function setProductStatus(input: SetProductStatusInput): SetProductStatusResult {
  const product = getProduct(input.productId);
  if (!product) return { ok: false, error: `Product ${input.productId} not found` };
  if (!["active", "clearance", "hold"].includes(input.status)) {
    return { ok: false, error: "status must be 'active', 'clearance' or 'hold'" };
  }
  product.status = input.status;
  if (input.status === "clearance") {
    const pct = input.markdownPct ?? product.markdownPct ?? 0.25;
    product.markdownPct = Math.min(0.9, Math.max(0.05, pct));
  } else {
    product.markdownPct = undefined;
  }
  return { ok: true, product };
}

// ── Read models for the dashboard ───────────────────────────────────────────

export interface InventoryView {
  id: string;
  name: string;
  brand: string;
  category: Category;
  status: ProductStatus;
  coldChain: boolean;
  stock: number;
  reorderPoint: number;
  parLevel: number;
  low: boolean;
  unitCostCents: number;
  retailCents: number;
  valueCents: number;
  weeklyVelocity: number;
  daysOfCover: number | null;
  nearestExpiry: string;
  daysToExpiry: number;
  nearExpiry: boolean;
  lots: number;
  expiredUnits: number;
  markdownPct?: number;
  complianceFlag?: string;
}

/** Product list enriched with derived inventory metrics for the dashboard. */
export function listInventory(asOf = ASOF): InventoryView[] {
  const cutoff = asOf.toISOString().slice(0, 10);
  return [...state.products.values()].map((p) => {
    const lots = state.lots.get(p.id) ?? [];
    const vel = weeklyVelocity(p.id);
    const daily = vel / 7;
    const daysOfCover = daily > 0 ? Math.round(p.stock / daily) : null;
    const daysToExpiry = daysUntil(p.expiryDate, asOf);
    const expiredUnits = lots.filter((l) => l.expiryDate <= cutoff).reduce((n, l) => n + l.units, 0);
    return {
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      status: p.status,
      coldChain: p.coldChain,
      stock: p.stock,
      reorderPoint: p.reorderPoint,
      parLevel: p.parLevel,
      low: p.stock <= p.reorderPoint,
      unitCostCents: p.unitCostCents,
      retailCents: p.priceCents,
      valueCents: p.stock * p.unitCostCents,
      weeklyVelocity: Math.round(vel * 10) / 10,
      daysOfCover,
      nearestExpiry: p.expiryDate,
      daysToExpiry,
      nearExpiry: daysToExpiry <= 60,
      lots: lots.length,
      expiredUnits,
      markdownPct: p.markdownPct,
      complianceFlag: p.complianceFlag,
    };
  });
}

export interface InventoryHealth {
  activeSkus: number;
  lowStock: number;
  complianceHolds: number;
  clearance: number;
  totalUnits: number;
  totalValueCents: number;
  expiringSoonUnits: number;
  expiringSoonValueCents: number;
  expiringWithinDays: number;
  expiredUnits: number;
  expiredValueCents: number;
}

/** Category-wide inventory KPIs. */
export function getInventoryHealth(asOf = ASOF): InventoryHealth {
  const cutoff = asOf.toISOString().slice(0, 10);
  const within = 30;
  let totalUnits = 0;
  let totalValueCents = 0;
  let lowStock = 0;
  let complianceHolds = 0;
  let clearance = 0;
  let expiringSoonUnits = 0;
  let expiringSoonValueCents = 0;
  let expiredUnits = 0;
  let expiredValueCents = 0;
  for (const p of state.products.values()) {
    totalUnits += p.stock;
    totalValueCents += p.stock * p.unitCostCents;
    if (p.stock <= p.reorderPoint) lowStock++;
    if (p.status === "hold" || p.complianceFlag) complianceHolds++;
    if (p.status === "clearance") clearance++;
    for (const lot of state.lots.get(p.id) ?? []) {
      const d = daysUntil(lot.expiryDate, asOf);
      if (lot.expiryDate <= cutoff) {
        expiredUnits += lot.units;
        expiredValueCents += lot.units * lot.unitCostCents;
      } else if (d <= within) {
        expiringSoonUnits += lot.units;
        expiringSoonValueCents += lot.units * lot.unitCostCents;
      }
    }
  }
  return {
    activeSkus: state.products.size,
    lowStock,
    complianceHolds,
    clearance,
    totalUnits,
    totalValueCents,
    expiringSoonUnits,
    expiringSoonValueCents,
    expiringWithinDays: within,
    expiredUnits,
    expiredValueCents,
  };
}

export interface LowStockItem {
  product: Product;
  shortfall: number;
  nearExpiry: boolean;
}

/** Products at/below reorder point, with a near-expiry flag (within ~75 days). */
export function listLowStock(asOf = ASOF): LowStockItem[] {
  const items: LowStockItem[] = [];
  for (const p of state.products.values()) {
    if (p.stock <= p.reorderPoint) {
      const days = (new Date(p.expiryDate).getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24);
      items.push({ product: p, shortfall: p.reorderPoint - p.stock, nearExpiry: days <= 75 });
    }
  }
  return items.sort((a, b) => b.shortfall - a.shortfall);
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  lines: Array<{ productId: string; units: number }>;
  note?: string;
  submit?: boolean;
}

export interface CreatePurchaseOrderResult {
  ok: boolean;
  error?: string;
  order?: PurchaseOrder;
  belowMinimum?: boolean;
}

/**
 * Create a purchase order against a supplier. Mutates the backend: records the
 * PO and, when submitted, increments product stock by the ordered units
 * (goods received). Wholesale unit cost is ~60% of retail.
 */
export function createPurchaseOrder(input: CreatePurchaseOrderInput): CreatePurchaseOrderResult {
  const supplier = getSupplier(input.supplierId);
  if (!supplier) return { ok: false, error: `Supplier ${input.supplierId} not found` };
  if (!input.lines || input.lines.length === 0) return { ok: false, error: "Order has no lines" };

  const lines: PurchaseOrderLine[] = [];
  let total = 0;
  for (const l of input.lines) {
    const product = getProduct(l.productId);
    if (!product) return { ok: false, error: `Product ${l.productId} not found` };
    if (product.supplierId !== supplier.id) {
      return { ok: false, error: `${product.id} is not supplied by ${supplier.id}` };
    }
    if (l.units <= 0) return { ok: false, error: `Units for ${product.id} must be positive` };
    const unitCostCents = Math.round(product.priceCents * 0.6);
    lines.push({ productId: product.id, units: l.units, unitCostCents });
    total += unitCostCents * l.units;
  }

  const order: PurchaseOrder = {
    id: `PO-${++state.counters.po}`,
    supplierId: supplier.id,
    lines,
    totalCents: total,
    status: input.submit ? "submitted" : "draft",
    note: input.note ?? "",
    createdAt: new Date().toISOString(),
  };
  state.purchaseOrders.push(order);

  if (order.status === "submitted") {
    // Goods received: each line becomes a new lot and a ledger receipt.
    const expiryDate = addMonthsIso(ASOF, DEFAULT_SHELF_LIFE_MONTHS);
    for (const l of lines) {
      receiveStock({
        productId: l.productId,
        units: l.units,
        unitCostCents: l.unitCostCents,
        expiryDate,
        refId: order.id,
        note: `Received against ${order.id}`,
      });
    }
  }

  return { ok: true, order, belowMinimum: total < supplier.minOrderCents };
}

/** Format minor units (cents) as a human-readable USD string. */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
