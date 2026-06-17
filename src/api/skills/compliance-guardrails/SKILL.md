---
name: compliance-guardrails
description: Food-safety guardrails for restocking grocery products — active recalls, allergen and labeling rules, prohibited or restricted ingredients, and cold-chain integrity. Consult this BEFORE approving any restock, and ALWAYS for a product that carries a compliance flag, to decide whether to place a HOLD.
---

# Food-safety guardrails (Contoso Market — Grocery)

Apply these guardrails before approving any restock. When a product carries a
`complianceFlag`, treat this skill as mandatory and default to a **HOLD** until
every check passes.

## 1. Active recall → HOLD
Place an immediate **HOLD** (do not reorder) if the product is subject to an
active supplier or regulatory **recall** — for example an ingredient above the
permitted limit, an unapproved additive, contamination, or a manufacturing
defect. A recall HOLD cannot be cleared by a supplier swap or a price change; the
product itself is the problem. Keep it on hold until the recall is officially
lifted, then re-verify the affected lots.

## 2. Prohibited / restricted ingredients → HOLD
Place a **HOLD** if the product contains an ingredient that is banned or
restricted for retail sale, or that exceeds a legal limit (e.g. caffeine or other
additives above the permitted amount). Escalate for reformulation or delisting.

## 3. Allergens & labeling
Require complete, accurate labeling: declared allergens, ingredient list,
net weight, and a **best-before / use-by date**. Reject unapproved health or
disease claims (e.g. "cures anxiety"). HOLD anything with missing or misleading
label data.

## 4. Cold-chain integrity
For refrigerated or frozen items (dairy, produce, frozen), require validated
temperature-controlled shipping and receipt temperature logs; otherwise HOLD on
receipt.

## 5. Output format
State a clear verdict — **CLEAR** or **HOLD** — the specific reason, and the
next step (reorder / hold until recall cleared / fix labeling / delist).
