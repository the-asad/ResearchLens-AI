import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, signupSchema, uploadRequestSchema, idParamSchema } from "@/lib/validation";

const validUpload = {
  kind: "paper",
  projectId: "3f1c2a7e-9b4d-4c1e-8a2b-1d2e3f4a5b6c",
  filename: "paper.pdf",
  size: 1000,
  mimeType: "application/pdf",
};

describe("uploadRequestSchema", () => {
  it("accepts a valid request", () => expect(uploadRequestSchema.safeParse(validUpload).success).toBe(true));
  it("rejects non-PDF MIME", () =>
    expect(uploadRequestSchema.safeParse({ ...validUpload, mimeType: "text/html" }).success).toBe(false));
  it("rejects oversize files", () =>
    expect(uploadRequestSchema.safeParse({ ...validUpload, size: MAX_PDF_BYTES + 1 }).success).toBe(false));
  it("rejects non-UUID project ids", () =>
    expect(uploadRequestSchema.safeParse({ ...validUpload, projectId: "1 or 1=1" }).success).toBe(false));
  it("rejects zero-byte files", () => expect(uploadRequestSchema.safeParse({ ...validUpload, size: 0 }).success).toBe(false));
});

describe("signupSchema", () => {
  it("requires a reasonably strong password", () => {
    expect(signupSchema.safeParse({ displayName: "A", email: "a@b.co", password: "short" }).success).toBe(false);
    expect(signupSchema.safeParse({ displayName: "A", email: "a@b.co", password: "longenough1" }).success).toBe(true);
  });
});

describe("idParamSchema", () => {
  it("rejects path traversal", () => expect(idParamSchema.safeParse({ id: "../x" }).success).toBe(false));
});

describe("note uploads", () => {
  it("accepts image notes up to 15 MB and rejects PDFs or SVG as notes", async () => {
    const { uploadRequestSchema, MAX_NOTE_BYTES } = await import("@/lib/validation");
    const base = { kind: "note", projectId: "3f1c2a7e-9b4d-4c1e-8a2b-1d2e3f4a5b6c", filename: "notes.jpg", size: 1000 };
    expect(uploadRequestSchema.safeParse({ ...base, mimeType: "image/jpeg" }).success).toBe(true);
    expect(uploadRequestSchema.safeParse({ ...base, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({ ...base, mimeType: "application/pdf" }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({ ...base, mimeType: "image/png", size: MAX_NOTE_BYTES + 1 }).success).toBe(false);
  });
  it("checks image magic bytes", async () => {
    const { imageSignature } = await import("@/lib/pdf");
    expect(imageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(imageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageSignature(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(imageSignature(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });
});
