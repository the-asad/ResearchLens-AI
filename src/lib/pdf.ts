/** PDF validation helpers (pure; unit-tested). */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * True if the bytes contain the %PDF- header. The spec allows the header to appear
 * within the first 1024 bytes, so we scan that window.
 */
export function hasPdfSignature(bytes: Uint8Array) {
  const limit = Math.min(bytes.length, 1024) - PDF_MAGIC.length;
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Display-only filename cleanup. Storage paths never use the filename; this just keeps
 * stored metadata tidy (no path segments, control chars or absurd lengths).
 */
export function sanitizeDisplayFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  const safe = cleaned.length > 0 ? cleaned : "document.pdf";
  return safe.length > 255 ? `${safe.slice(0, 251)}.pdf` : safe;
}

export function hasPdfExtension(name: string) {
  return /\.pdf$/i.test(name.trim());
}

/** Image signature check for note uploads (PNG, JPEG, WebP). */
export function imageSignature(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const b = (i: number) => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (String.fromCharCode(b(0), b(1), b(2), b(3)) === "RIFF" && String.fromCharCode(b(8), b(9), b(10), b(11)) === "WEBP") return "image/webp";
  return null;
}
