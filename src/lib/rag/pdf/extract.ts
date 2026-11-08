import { getDocumentProxy } from "unpdf";
import { bodyFontSize, buildBlocks, buildLines, detectTitle, orderLines, stripMargins } from "./layout";
import type { ExtractedDocument, Line, RawItem, RawPage } from "./types";

export class PdfExtractionError extends Error {
  constructor(message: string, readonly code: "unreadable" | "encrypted" | "no_text" | "garbled" | "too_many_pages") {
    super(message);
    this.name = "PdfExtractionError";
  }
}

export const MAX_PAGES = 400;
const BOLD_FONT = /(bold|black|heavy|semibold|demi|medi(um)?\b|-?medi$|cmbx|\.b$|-b$|,bold)/i;

type PdfTextItem = { str: string; transform: number[]; width: number; fontName: string };

/** Read positioned text runs page by page with pdf.js (via unpdf's serverless build). */
export async function readPdf(bytes: Uint8Array): Promise<RawPage[]> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes, { useSystemFonts: false });
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "PasswordException") throw new PdfExtractionError("PDF is password-protected.", "encrypted");
    throw new PdfExtractionError("PDF could not be parsed.", "unreadable");
  }
  if (pdf.numPages > MAX_PAGES) {
    throw new PdfExtractionError(`PDF has ${pdf.numPages} pages; the limit is ${MAX_PAGES}.`, "too_many_pages");
  }

  const pages: RawPage[] = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      // Loading the operator list resolves font objects so real font names (→ bold) are known.
      await page.getOperatorList();
      const fontBold = new Map<string, boolean>();
      const isBold = (fontName: string) => {
        if (!fontBold.has(fontName)) {
          let bold = false;
          try {
            const font = page.commonObjs.get(fontName) as { name?: string; bold?: boolean } | undefined;
            bold = Boolean(font?.bold) || BOLD_FONT.test(font?.name ?? "");
          } catch {
            bold = false;
          }
          fontBold.set(fontName, bold);
        }
        return fontBold.get(fontName)!;
      };
      const items: RawItem[] = [];
      for (const raw of content.items as PdfTextItem[]) {
        if (typeof raw.str !== "string") continue;
        const [, b, c, d, e, f] = raw.transform;
        items.push({
          str: raw.str,
          x: e - viewport.viewBox[0],
          y: f - viewport.viewBox[1],
          width: raw.width,
          size: Math.abs(d) || Math.hypot(c, d),
          fontName: raw.fontName,
          bold: isBold(raw.fontName),
          rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01,
        });
      }
      pages.push({ pageNumber: p, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
  return pages;
}

/** Full extraction: runs → ordered lines → margin cleanup → heading/paragraph blocks. */
export function extractStructure(pages: RawPage[]): ExtractedDocument {
  const warnings: string[] = [];
  const body = bodyFontSize(pages);
  const ordered = pages.map((p) => ({ lines: orderLines(buildLines(p, body), p.width), height: p.height }));
  const stripped = stripMargins(ordered);

  const reports = pages.map((p, i) => {
    const chars = stripped[i].lines.reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
    return { pageNumber: p.pageNumber, chars, empty: chars < 25, droppedLines: stripped[i].dropped };
  });

  const allLines: Line[] = stripped.flatMap((s) => s.lines);
  const totalChars = reports.reduce((n, r) => n + r.chars, 0);
  if (totalChars < 200) {
    throw new PdfExtractionError(
      "No extractable text found. The PDF may be scanned or image-only; OCR is not supported yet.",
      "no_text",
    );
  }
  const emptyPages = reports.filter((r) => r.empty).map((r) => r.pageNumber);
  if (emptyPages.length > pages.length / 2) {
    throw new PdfExtractionError(
      `Most pages (${emptyPages.length}/${pages.length}) have no extractable text — likely scanned. OCR is not supported yet.`,
      "no_text",
    );
  }
  if (emptyPages.length) warnings.push(`Pages without extractable text: ${emptyPages.join(", ")}`);

  const text = allLines.map((l) => l.text).join("");
  const bad = (text.match(/[�-]/g) ?? []).length;
  if (text.length > 0 && bad / text.length > 0.2) {
    throw new PdfExtractionError("Extracted text is mostly unreadable (broken font encoding).", "garbled");
  }

  const title = detectTitle(allLines, pages[0]?.height ?? 792, body);
  const isTitleLine = (l: Line) => title !== null && l.page === 1 && l.size >= body * 1.2 && title.includes(l.text.trim());
  const blocks = buildBlocks(allLines, body, isTitleLine);

  return { pageCount: pages.length, title, blocks, pages: reports, bodyFontSize: body, warnings };
}

export async function extractPdf(bytes: Uint8Array) {
  return extractStructure(await readPdf(bytes));
}
