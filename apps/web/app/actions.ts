"use server";

import { api, type ExtractResponse } from "../lib/api";

export type ExtractState =
  | { status: "idle" }
  | { status: "ok"; fileName: string; result: ExtractResponse }
  | { status: "error"; message: string };

const MAX_BYTES = 5 * 1024 * 1024;

export async function extractReceipt(_previous: ExtractState, form: FormData): Promise<ExtractState> {
  const file = form.get("receipt");
  if (!(file instanceof File) || file.size === 0) return { status: "error", message: "Choose a receipt image first." };
  if (file.size > MAX_BYTES) return { status: "error", message: "That image is over 5 MB." };

  const image_base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const res = await api<ExtractResponse>("/v1/extract", { method: "POST", body: JSON.stringify({ image_base64 }) });
  return res.ok ? { status: "ok", fileName: file.name, result: res.data } : { status: "error", message: res.message };
}
