---
type: API Endpoint
title: Billing API
description: REST endpoint that creates and lists customer charges.
resource: https://api.acme.internal/v2/billing
tags:
  - billing
  - rest
generated:
  by: human:maintainers
  at: '2026-07-09T00:00:00Z'
sources:
  - id: billing-runbook
    resource: https://wiki.acme.internal/billing/runbook
    title: Internal billing runbook
---

Monthly charges are created by the scheduler; ad-hoc charges come from support tooling.[^billing-runbook]
Charges reference customers in the [Customers table](/tables/customers.md).

# Schema

* `POST /v2/billing/charges` — create a charge `{ customer_id, amount_cents, currency }`
* `GET /v2/billing/charges?customer_id=` — list charges for a customer

[^billing-runbook]: Internal billing runbook
