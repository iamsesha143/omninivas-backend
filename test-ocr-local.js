// Local OCR runner: renders the PDF to PNGs with pdfjs + node-canvas, then OCRs with tesseract.js.
// Usage: node test-ocr-local.js "4162 rental agreement.pdf" [maxPages]
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const Tesseract = require('tesseract.js');

async function main() {
  const file = process.argv[2] || '4162 rental agreement.pdf';
  const maxPages = parseInt(process.argv[3] || '3', 10);
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  console.error(`PDF has ${pdf.numPages} pages; OCRing first ${Math.min(maxPages, pdf.numPages)}...`);
  let allText = '';
  for (let p = 1; p <= Math.min(maxPages, pdf.numPages); p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const png = path.join(__dirname, `ocr-page-${p}.png`);
    fs.writeFileSync(png, canvas.toBuffer('image/png'));
    console.error(`page ${p} rendered, OCRing...`);
    const result = await Tesseract.recognize(png, 'eng');
    allText += result.data.text + '\n';
    fs.unlinkSync(png);
  }
  console.log(allText);
}

main().catch(err => { console.error(err); process.exit(1); });
