---
name: reorder-playbook
description: Official Contoso Market policy for turning a demand signal into a purchase order — case-size rounding, supplier minimum order value, safety stock, and near-expiry caps. Consult this BEFORE recommending any reorder quantity so the numbers follow store policy.
---

# Reorder playbook (Contoso Market — Supplements)

Use this playbook whenever you recommend *how much* to reorder. It encodes the
category manager's standing policy so quantities are consistent and defensible.

## 1. Order in case-size multiples
Never propose loose units. Round the recommended quantity **up** to the nearest
case (`caseSize`). State both: "5 cases (60 units)".

## 2. Cover demand to the next delivery + safety stock
Target on-hand after receipt ≈ **(weekly demand × (lead-time weeks + 1)) + reorder point**.
Lead time comes from the product's supplier. When demand is rising, weight the
most recent weeks more heavily.

## 3. Respect the supplier minimum order value
If the order total is below the supplier's `minimumOrder`, flag it and either
top up with other due-soon SKUs from the **same** supplier or tell the manager
the order is below minimum.

## 4. Cap near-expiry items
If an item is within ~6 weeks of `expiry`, do **not** build deep stock. Cap the
order so received units can realistically sell through before expiry, even if
forecast demand is higher. Call this out explicitly.

## 5. Cold-chain items
For `coldChain` products (e.g. probiotics), confirm refrigerated shipping is part
of the order and keep quantities tighter to limit time at temperature.

## 6. Never bypass a compliance HOLD
If the Supplier & Compliance specialist (or the compliance-guardrails skill)
returns a HOLD, do not produce a reorder quantity for that SKU at all.
