// Prints the property and tenant fields extracted from a rental agreement PDF.
// Usage: node test-extraction.js ["4162 rental agreement.pdf"]
// OCR of the first run is cached next to the PDF (<name>.ocr.txt) so re-runs are instant.
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const Tesseract = require('tesseract.js');
const { parsePropertyFromText, parseTenantsFromText } = require('./parsers');

async function ocrPdf(file, maxPages = 3) {
  const cache = file + '.ocr.txt';
  if (fs.existsSync(cache)) {
    console.log(`(using cached OCR text from ${path.basename(cache)})`);
    return fs.readFileSync(cache, 'utf8');
  }
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  console.log(`OCRing first ${Math.min(maxPages, pdf.numPages)} of ${pdf.numPages} pages (about a minute)...`);
  let allText = '';
  for (let p = 1; p <= Math.min(maxPages, pdf.numPages); p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const png = path.join(__dirname, `ocr-page-${p}.png`);
    fs.writeFileSync(png, canvas.toBuffer('image/png'));
    const result = await Tesseract.recognize(png, 'eng');
    allText += result.data.text + '\n';
    fs.unlinkSync(png);
  }
  fs.writeFileSync(cache, allText);
  return allText;
}

async function main() {
  const file = process.argv[2] || '4162 rental agreement.pdf';
  const text = await ocrPdf(file);

  console.log('\n=== PROPERTY ===');
  const prop = parsePropertyFromText(text);
  for (const [k, v] of Object.entries(prop)) console.log(`  ${k}: ${v}`);

  console.log('\n=== TENANTS ===');
  const tenants = parseTenantsFromText(text);
  if (tenants.length === 0) console.log('  (none found)');
  tenants.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.name}  phone=${t.personal_phone || '-'}  email=${t.personal_email || '-'}  aadhar=${t.aadhar_card || '-'}  move-in=${t.date_of_move_in || '-'}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
