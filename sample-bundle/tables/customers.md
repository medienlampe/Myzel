---
type: BigQuery Table
title: Customers
description: 'Core customer dimension table, one row per registered customer.'
resource: 'bq://acme-prod.crm.customers'
tags:
  - crm
  - pii
generated:
  by: human:maintainers
  at: '2026-07-09T15:10:01Z'
verified:
  by: human:data-eng
  at: '2026-07-10T09:00:00Z'
---
The canonical customer record. Downstream marts join on `customer_id`.
Billing events reference this table from the [Billing API](/apis/billing-api.md).

# Schema

* `customer_id` (STRING, required) — stable UUID
* `email` (STRING) — PII, masked in non-prod
* `country` (STRING) — ISO 3166-1 alpha-2
* `created_at` (TIMESTAMP)

# Examples

```sql
SELECT country, COUNT(*) AS customers
FROM `acme-prod.crm.customers`
GROUP BY country;
```

# Partitioning & SLA

The table is partitioned daily on `created_at`. Partitions are expected to land by 06:00 UTC each day. Late-arriving partitions automatically trigger a page to the data-eng on-call rotation.
