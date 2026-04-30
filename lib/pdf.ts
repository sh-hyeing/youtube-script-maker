import { jsPDF } from "jspdf";
import type { ScriptPair } from "@/lib/gemini";

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
 let binary = "";
 const bytes = new Uint8Array(buffer);
 const chunkSize = 8192;

 for (let i = 0; i < bytes.length; i += chunkSize) {
  const chunk = bytes.subarray(i, i + chunkSize);
  binary += String.fromCharCode(...chunk);
 }

 return btoa(binary);
};

const loadPdfFont = async () => {
 const response = await fetch("/fonts/NotoSansKR-Regular.ttf");
 if (!response.ok) {
  throw new Error("PDF용 한글 폰트 파일을 찾지 못했습니다. public/fonts/NotoSansKR-Regular.ttf 경로를 확인해 주세요.");
 }

 const buffer = await response.arrayBuffer();
 return arrayBufferToBase64(buffer);
};

type DownloadStudyScriptPdfParams = {
 pairs: ScriptPair[];
 videoUrl: string;
 filename?: string;
};

export const downloadStudyScriptPdf = async ({ pairs, videoUrl, filename = "study-script.pdf" }: DownloadStudyScriptPdfParams) => {
 if (!pairs.length) return;

 const doc = new jsPDF({
  orientation: "p",
  unit: "mm",
  format: "a4",
 });

 const fontBase64 = await loadPdfFont();
 doc.addFileToVFS("NotoSansKR-Regular.ttf", fontBase64);
 doc.addFont("NotoSansKR-Regular.ttf", "NotoSansKR", "normal");
 doc.setFont("NotoSansKR", "normal");

 const pageWidth = doc.internal.pageSize.getWidth();
 const pageHeight = doc.internal.pageSize.getHeight();

 const marginLeft = 16;
 const marginRight = 16;
 const marginTop = 18;
 const marginBottom = 18;
 const contentWidth = pageWidth - marginLeft - marginRight;

 const titleFontSize = 18;
 const metaFontSize = 10;
 const cellFontSize = 10.5;
 const lineHeight = 5.8;
 const cellPaddingX = 4;
 const cellPaddingY = 3.4;
 const numberColumnWidth = 16;
 const englishColumnWidth = (contentWidth - numberColumnWidth) * 0.58;
 const koreanColumnWidth = contentWidth - numberColumnWidth - englishColumnWidth;

 let y = marginTop;

 const drawHeader = () => {
  doc.setFont("NotoSansKR", "normal");
  doc.setTextColor(24, 32, 44);
  doc.setFontSize(titleFontSize);
  doc.text("Study Script", marginLeft, y);
  y += 8;

  if (videoUrl) {
   doc.setFontSize(metaFontSize);
   const sourceLines = doc.splitTextToSize(`Source: ${videoUrl}`, contentWidth);
   doc.text(sourceLines, marginLeft, y);
   y += sourceLines.length * 4.5 + 4;
  }

  doc.setDrawColor(210);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 8;
 };

 const ensurePageSpace = (requiredHeight: number) => {
  if (y + requiredHeight > pageHeight - marginBottom) {
   doc.addPage();
   y = marginTop;
   drawHeader();
  }
 };

 const drawCellText = (lines: string[], x: number, top: number, width: number, rowHeight: number, align: "left" | "center") => {
  const safeLines = lines.length > 0 ? lines : [" "];
  const firstLineY = top + rowHeight / 2 - ((safeLines.length - 1) * lineHeight) / 2;
  const textX = align === "center" ? x + width / 2 : x + cellPaddingX;

  safeLines.forEach((line, lineIndex) => {
   const y = firstLineY + lineIndex * lineHeight;
   const options = align === "center" ? { align: "center" as const, baseline: "middle" as const } : { baseline: "middle" as const };
   doc.text(line, textX, y, options);
  });
 };

 drawHeader();

 for (let i = 0; i < pairs.length; i += 1) {
  const pair = pairs[i];
  const numberText = String(i + 1);
  const englishText = String(pair.en || "")
   .replace(/\s+/g, " ")
   .trim();
  const koreanText = String(pair.ko || "")
   .replace(/\s+/g, " ")
   .trim();

  doc.setFontSize(cellFontSize);
  const numberLines = [numberText];
  const englishLines = doc.splitTextToSize(englishText || " ", Math.max(1, englishColumnWidth - cellPaddingX * 2));
  const koreanLines = doc.splitTextToSize(koreanText || " ", Math.max(1, koreanColumnWidth - cellPaddingX * 2));

  const rowContentHeight = Math.max(numberLines.length, englishLines.length, koreanLines.length) * lineHeight;
  const rowHeight = rowContentHeight + cellPaddingY * 2;

  ensurePageSpace(rowHeight);

  const rowTop = y;
  const numberX = marginLeft;
  const englishX = numberX + numberColumnWidth;
  const koreanX = englishX + englishColumnWidth;
  const rowBottom = rowTop + rowHeight;

  doc.setDrawColor(220, 224, 231);
  doc.setLineWidth(0.2);
  doc.line(numberX, rowTop, pageWidth - marginRight, rowTop);
  doc.line(numberX, rowBottom, pageWidth - marginRight, rowBottom);
  doc.line(numberX, rowTop, numberX, rowBottom);
  doc.line(englishX, rowTop, englishX, rowBottom);
  doc.line(koreanX, rowTop, koreanX, rowBottom);
  doc.line(pageWidth - marginRight, rowTop, pageWidth - marginRight, rowBottom);

  doc.setFontSize(cellFontSize);
  doc.setTextColor(110, 119, 136);
  drawCellText(numberLines, numberX, rowTop, numberColumnWidth, rowHeight, "center");

  doc.setTextColor(34, 41, 55);
  drawCellText(englishLines, englishX, rowTop, englishColumnWidth, rowHeight, "left");

  doc.setTextColor(76, 85, 104);
  drawCellText(koreanLines, koreanX, rowTop, koreanColumnWidth, rowHeight, "left");

  y += rowHeight;
 }

 doc.save(filename);
};
