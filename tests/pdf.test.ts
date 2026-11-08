import { describe, expect, it } from "vitest";
import { hasPdfExtension, hasPdfSignature, sanitizeDisplayFilename } from "@/lib/pdf";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("hasPdfSignature", () => {
  it("accepts a standard PDF header", () => expect(hasPdfSignature(bytes("%PDF-1.7\n..."))).toBe(true));
  it("accepts a header within the first 1024 bytes", () =>
    expect(hasPdfSignature(bytes(`${" ".repeat(500)}%PDF-1.4`))).toBe(true));
  it("rejects a header beyond 1024 bytes", () =>
    expect(hasPdfSignature(bytes(`${" ".repeat(1100)}%PDF-1.4`))).toBe(false));
  it("rejects HTML renamed to .pdf", () => expect(hasPdfSignature(bytes("<html><script>"))).toBe(false));
  it("rejects a PNG", () => expect(hasPdfSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false));
  it("rejects empty input", () => expect(hasPdfSignature(new Uint8Array())).toBe(false));
});

describe("sanitizeDisplayFilename", () => {
  it("strips path segments", () => expect(sanitizeDisplayFilename("../../etc/passwd.pdf")).toBe("passwd.pdf"));
  it("strips windows paths", () => expect(sanitizeDisplayFilename("C:\\x\\paper.pdf")).toBe("paper.pdf"));
  it("removes control characters", () => expect(sanitizeDisplayFilename("a\u0000b\nc.pdf")).toBe("abc.pdf"));
  it("caps length", () => expect(sanitizeDisplayFilename(`${"a".repeat(400)}.pdf`).length).toBeLessThanOrEqual(255));
  it("falls back when empty", () => expect(sanitizeDisplayFilename("/")).toBe("document.pdf"));
});

describe("hasPdfExtension", () => {
  it("is case-insensitive", () => expect(hasPdfExtension("Paper.PDF")).toBe(true));
  it("rejects double extensions ending elsewhere", () => expect(hasPdfExtension("paper.pdf.exe")).toBe(false));
});
