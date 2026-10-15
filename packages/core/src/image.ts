import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageMime } from "./providers/types.js";

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

/** Detects the format from magic bytes, never from the file name or a caller-supplied type. */
export function sniffMime(bytes: Buffer): ImageMime | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export interface ImageSource {
  path?: string | undefined;
  base64?: string | undefined;
}

/**
 * Loads an image from exactly one source. Because the server reads paths an
 * agent passes in, anything that is not a PNG, JPEG, GIF or WebP is rejected
 * by content, so the tool cannot be used to read arbitrary files.
 */
export async function loadImage(source: ImageSource, maxBytes: number, cwd = process.cwd()): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
  if (Boolean(source.path) === Boolean(source.base64)) {
    throw new ImageInputError("Provide exactly one of image_path or image_base64.");
  }

  let bytes: Buffer;
  if (source.path) {
    const path = resolve(cwd, source.path);
    const info = await stat(path).catch(() => {
      throw new ImageInputError(`No file at ${path}`);
    });
    if (!info.isFile()) throw new ImageInputError(`${path} is not a file`);
    if (info.size > maxBytes) throw new ImageInputError(`Image is ${info.size} bytes; the limit is ${maxBytes}.`);
    bytes = await readFile(path);
  } else {
    bytes = Buffer.from(source.base64!.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (bytes.length > maxBytes) throw new ImageInputError(`Image is ${bytes.length} bytes; the limit is ${maxBytes}.`);
  }

  const mimeType = sniffMime(bytes);
  if (!mimeType) throw new ImageInputError("Unsupported content: expected a PNG, JPEG, GIF or WebP image.");
  return { bytes, mimeType };
}
