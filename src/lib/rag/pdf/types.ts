/** Positioned text run as produced by the PDF text layer (PDF user space: origin bottom-left). */
export type RawItem = {
  str: string;
  x: number;
  y: number; // baseline
  width: number;
  size: number; // font size (|transform[3]|)
  fontName: string;
  bold: boolean;
  rotated: boolean;
};

export type RawPage = { pageNumber: number; width: number; height: number; items: RawItem[] };

/** A horizontal run of text on one baseline, within one column. */
export type Line = {
  page: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
  column: "full" | "left" | "right";
};

export type SectionKind = "front_matter" | "abstract" | "body" | "references" | "appendix";

export type Block = {
  kind: "heading" | "paragraph";
  text: string;
  page: number;
  /** Last page this block's text appears on (paragraphs can continue across a page break). */
  pageEnd?: number;
  /** Heading numbering depth (1 = "3", 2 = "3.1"); 1 for unnumbered headings. */
  level?: number;
  /** Heading detected only from font size (weaker evidence than numbering/known names). */
  bySize?: boolean;
  /** Figure/table caption ("Table 2: ..."). */
  caption?: boolean;
  /** Mostly numbers/short tokens — linearised table or figure text, not prose. */
  tableLike?: boolean;
  /** Text recognised by OCR (page had no digital text layer). */
  ocr?: boolean;
};

export type PageReport = { pageNumber: number; chars: number; empty: boolean; droppedLines: number };

export type ExtractedDocument = {
  pageCount: number;
  title: string | null;
  blocks: Block[];
  pages: PageReport[];
  bodyFontSize: number;
  warnings: string[];
};
