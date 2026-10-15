---
description: Show ModelGate budget, vendor health and this month's usage
---

Call the ModelGate `get_status` and `get_report` tools, then summarise in at most six lines:

1. Budget: spent, limit and remaining for the current month. Flag it if more than 80% is used.
2. Routing order and any vendor whose circuit breaker is open, with the reason and when it reopens.
3. Success rate, fallback rate and silent failures caught.
4. Cost per successful extraction and p95 latency.

Do not call `extract_receipt`.
