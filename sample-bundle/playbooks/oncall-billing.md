---
type: Playbook
title: Billing On-call Playbook
description: What to do when billing charge failures spike.
tags:
  - billing
  - oncall
status: stable
generated:
  by: human:maintainers
  at: '2026-07-09T00:00:00Z'
---

When the `billing_charge_failures` alert fires:

1. Check the [Billing API](/apis/billing-api.md) error rate dashboard.
2. Verify the [Customers table](/tables/customers.md) latest partition landed.
3. If the partition is late, page the data-eng on-call; do NOT retry charges manually.
