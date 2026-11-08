"""Create synthetic scanned PDFs (image-only, no text layer) from corpus pages for OCR tests.

clean:    200 dpi grayscale
degraded: 100 dpi, gaussian blur, noise, JPEG q=35
rotated:  200 dpi, rotated 2.5 degrees (skewed scan) and one page rotated 90 degrees
mixed:    pages 1-2 digital (original), page 3 scanned (image only)
"""
import io, random, sys
import pypdfium2 as pdfium
from PIL import Image, ImageFilter

src, out_dir = sys.argv[1], sys.argv[2]
pdf = pdfium.PdfDocument(src)

def render(i, dpi):
    return pdf[i].render(scale=dpi / 72).to_pil().convert("L")

def save(images, path, dpi):
    images[0].save(path, "PDF", resolution=dpi, save_all=True, append_images=images[1:])

pages = [0, 2, 3]  # title/abstract page + body pages
save([render(i, 200) for i in pages], f"{out_dir}/scan-clean.pdf", 200)

def degrade(im):
    im = im.filter(ImageFilter.GaussianBlur(0.8))
    px = im.load(); w, h = im.size; random.seed(7)
    for _ in range(w * h // 40):
        x, y = random.randrange(w), random.randrange(h); px[x, y] = random.choice((0, 255))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=35); return Image.open(buf).convert("L")
save([degrade(render(i, 100)) for i in pages], f"{out_dir}/scan-degraded.pdf", 100)

rot = [render(pages[0], 200).rotate(2.5, expand=True, fillcolor=255), render(pages[1], 200).rotate(90, expand=True, fillcolor=255)]
save(rot, f"{out_dir}/scan-rotated.pdf", 200)

# Mixed: digital pages 1-2 + one scanned page appended.
mixed = pdfium.PdfDocument.new()
mixed.import_pages(pdf, [0, 1])
img = render(3, 200); buf = io.BytesIO(); img.save(buf, "PDF", resolution=200)
mixed.import_pages(pdfium.PdfDocument(buf.getvalue()))
mixed.save(f"{out_dir}/scan-mixed.pdf")
print("ok")
