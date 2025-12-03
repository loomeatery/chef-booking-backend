import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";

async function testPDF() {
  const templatePath = path.join(process.cwd(), "pdf/giftcard-template.pdf");

  if (!fs.existsSync(templatePath)) {
    console.error("❌ Template not found:", templatePath);
    return;
  }

  const pdfBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const textColor = rgb(0, 0, 0);

  // --- MOCK TEST DATA (FREE, NO STRIPE) ---
  const RECIPIENT = "Melissa Talay";
  const BUYER = "Christopher LaMagna";
  const AMOUNT = 100; // cents → $1
  const CODE = "CHRIS-GIFT-TEST123";

  // --- DRAW TEXT EXACTLY LIKE YOUR REAL GENERATOR ---
  page.drawText(RECIPIENT, { x: 120, y: 335, size: 14, font: bold, color: textColor });
  page.drawText(BUYER, { x: 120, y: 290, size: 14, font: bold, color: textColor });
  page.drawText(`$${(AMOUNT/100).toFixed(2)}`, { x: 120, y: 245, size: 14, font: bold, color: textColor });
  page.drawText(CODE, { x: 120, y: 200, size: 14, font: bold, color: textColor });

  const out = await pdfDoc.save();
  fs.writeFileSync("TEST-giftcard-output.pdf", out);

  console.log("✅ PDF generated → TEST-giftcard-output.pdf");
}

testPDF();
