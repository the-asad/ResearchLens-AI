"""ResearchLens document-intelligence extractor (Docling).

Usage: python extract.py <input.pdf> <out.json> [--images-dir DIR] [--ocr auto|off|force]

Emits reading-ordered blocks (label, page, bbox, text), structured tables (caption, header,
rows, cells with bboxes) and figures (caption, bbox, optional PNG crop). Never invents text:
OCR is only used when requested ('force') or when a page has no programmatic text ('auto').
No network access is needed after models are cached; no secrets are read.
"""
import json, sys, time, argparse, os
import pypdfium2 as pdfium
import subprocess, tempfile


def image_confidence(path):
    from PIL import Image, ImageOps
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        ImageOps.exif_transpose(Image.open(path)).convert("L").save(f.name)
        return _tess_conf(f.name)


def tesseract_confidence(page, dpi=300):
    """Mean Tesseract word confidence (0-100) for a rendered page; None if unavailable."""
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        page.render(scale=dpi / 72).to_pil().convert("L").save(f.name)
        return _tess_conf(f.name)


def _tess_conf(fname):
    if True:
        try:
            out = subprocess.run(["tesseract", fname, "stdout", "-l", "eng", "--psm", "1", "tsv"],
                                 capture_output=True, text=True, timeout=120).stdout
        except Exception:
            return None
    confs = []
    for line in out.splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) >= 12 and cols[11].strip() and cols[10] not in ("-1", ""):
            try:
                c = float(cols[10])
                if c >= 0:
                    confs.append(c)
            except ValueError:
                pass
    return round(sum(confs) / len(confs), 1) if confs else 0.0

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions


def bbox(prov, page_heights):
    b = prov.bbox
    h = page_heights.get(prov.page_no)
    # Normalise to top-left origin in PDF points.
    tl = b.to_top_left_origin(page_height=h) if h else b
    return [round(tl.l, 1), round(tl.t, 1), round(tl.r, 1), round(tl.b, 1)]


def extract(pdf_path, images_dir=None, ocr="auto"):
    """Run Docling on one PDF and return the ResearchLens docintel dict."""
    a = argparse.Namespace(pdf=pdf_path, images_dir=images_dir, ocr=ocr)

    opts = PdfPipelineOptions()
    opts.do_table_structure = True
    opts.do_ocr = a.ocr != "off"
    if a.ocr == "force":
        from docling.datamodel.pipeline_options import TesseractCliOcrOptions
        opts.ocr_options = TesseractCliOcrOptions(lang=["eng"], force_full_page_ocr=True)
    elif a.ocr == "auto":
        from docling.datamodel.pipeline_options import TesseractCliOcrOptions
        opts.ocr_options = TesseractCliOcrOptions(lang=["eng"], force_full_page_ocr=False)
    opts.generate_picture_images = bool(a.images_dir)
    opts.images_scale = 2.0

    t0 = time.time()
    conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    doc = conv.convert(a.pdf).document
    heights = {p.page_no: p.size.height for p in doc.pages.values()}

    blocks = []
    for item, level in doc.iterate_items():
        label = str(getattr(item, "label", "")).split(".")[-1].lower()
        if not getattr(item, "prov", None) or label in ("table", "picture"):
            continue
        text = getattr(item, "text", "") or ""
        if not text.strip():
            continue
        p = item.prov[0]
        blocks.append({"label": label, "page": p.page_no, "bbox": bbox(p, heights), "text": text, "level": level})

    tables = []
    for i, t in enumerate(doc.tables):
        p = t.prov[0] if t.prov else None
        grid = t.data.grid if t.data else []
        rows = [[c.text for c in row] for row in grid]
        cells = []
        for c in (t.data.table_cells if t.data else []):
            cells.append({
                "row": c.start_row_offset_idx, "col": c.start_col_offset_idx,
                "rowSpan": c.row_span, "colSpan": c.col_span, "text": c.text,
                "header": bool(c.column_header or c.row_header),
            })
        n_header = sum(1 for r in (t.data.grid if t.data else []) if r and all(c.column_header for c in r if c.text))
        tables.append({
            "index": i, "page": p.page_no if p else None, "bbox": bbox(p, heights) if p else None,
            "caption": t.caption_text(doc) or None, "numRows": t.data.num_rows if t.data else 0,
            "numCols": t.data.num_cols if t.data else 0, "headerRows": n_header, "rows": rows, "cells": cells,
        })

    figures = []
    for i, f in enumerate(doc.pictures):
        p = f.prov[0] if f.prov else None
        img_path = None
        if a.images_dir and p:
            img = f.get_image(doc)
            if img is not None:
                os.makedirs(a.images_dir, exist_ok=True)
                img_path = os.path.join(a.images_dir, f"figure-{i}-p{p.page_no}.png")
                img.save(img_path)
        figures.append({"index": i, "page": p.page_no if p else None, "bbox": bbox(p, heights) if p else None,
                        "caption": f.caption_text(doc) or None, "image": img_path})

    # Programmatic (digital) text per page: pages below the threshold had no text layer, so any
    # text Docling returns for them is OCR-derived and is labelled as such downstream.
    pages = []
    if a.pdf.lower().endswith(".pdf"):
        raw = pdfium.PdfDocument(a.pdf)
        for i in range(len(raw)):
            chars = raw[i].get_textpage().count_chars()
            is_ocr = a.ocr != "off" and chars < 25
            pages.append({"page": i + 1, "programmaticChars": chars, "ocr": is_ocr,
                          "ocrConfidence": tesseract_confidence(raw[i]) if is_ocr else None})
    else:  # image note: always OCR; confidence measured on the image itself
        pages.append({"page": 1, "programmaticChars": 0, "ocr": True, "ocrConfidence": image_confidence(a.pdf)})

    return {"pageCount": len(doc.pages), "seconds": round(time.time() - t0, 2), "ocr": a.ocr,
            "pages": pages, "blocks": blocks, "tables": tables, "figures": figures}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("out")
    ap.add_argument("--images-dir"); ap.add_argument("--ocr", default="off", choices=["auto", "off", "force"])
    a = ap.parse_args()
    json.dump(extract(a.pdf, a.images_dir, a.ocr), open(a.out, "w"))


if __name__ == "__main__":
    main()
