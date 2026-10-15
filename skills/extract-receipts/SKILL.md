---
name: extract-receipts
description: Extract structured data (merchant, date, currency, line items, tax, total) from receipt or invoice images with the ModelGate MCP server. Use when the user asks to read, digitise, total up, or export receipts, or points at image files of receipts.
---

# Extracting receipts with ModelGate

ModelGate's `extract_receipt` tool returns validated JSON. Each call costs money, so plan the calls before making them.

## Steps

1. Find the files. Accept PNG, JPEG, GIF or WebP. List what you found and how many before calling anything if there are more than 10.
2. Call `extract_receipt` once per image with `image_path`. Never call it twice for the same image in a session: reuse the earlier result.
3. Read the result before using it:
   - `warnings` means the output passed validation but something looks off (for example, line items not summing to the subtotal). Show the warning next to that receipt.
   - `fell_back: true` means the first vendor failed and another served the request. That is normal; mention it only if the user asks about reliability.
   - `isError` with "budget exhausted": stop. Do not retry any image. Tell the user the monthly limit was reached.
   - `isError` with "Every vendor failed": report that image as unreadable with the reasons from the attempts, and continue with the rest.
4. Present the results as a table (file, merchant, date, currency, total), then any warnings or failures. If the user asked for an export, write CSV with one row per line item and the receipt fields repeated.

## Rules

- Never fill in or correct a value the tool did not return. If a field looks wrong, say so and leave it as returned.
- Totals across receipts are only meaningful in one currency. Group by `currency` before summing.
- For cost or reliability questions, call `get_report` rather than estimating.
