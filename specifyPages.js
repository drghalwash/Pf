import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import fs from "fs";
import { PDFDocument } from "pdf-lib";

async function extractPages(pdfPath, ranges) {
  const existingPdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const newPdf = await PDFDocument.create();

  const totalPages = pdfDoc.getPageCount();

  // Convert range arrays into a single list of page numbers (0-based index)
  const pageNumbers = ranges.flatMap(([start, end]) =>
    Array.from(
      { length: Math.min(end, totalPages) - start + 1 },
      (_, i) => start + i - 1
    )
  );

  for (const pageNumber of pageNumbers) {
    const [copiedPage] = await newPdf.copyPages(pdfDoc, [pageNumber]);
    newPdf.addPage(copiedPage);
  }

  return await newPdf.save();
}

export async function parseSpecificPages(pdfPath, ranges) {
  const extractedPdfBytes = await extractPages(pdfPath, ranges);
  const data = await pdfParse(extractedPdfBytes);
  fs.writeFileSync("pdfData.txt", data.text);
  return data.text;
}
