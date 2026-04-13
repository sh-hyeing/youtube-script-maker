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
 const englishFontSize = 11;
 const koreanFontSize = 10;

 const lineHeight = 6;
 const blockGap = 3;
 const itemGap = 6;

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

 drawHeader();

 for (let i = 0; i < pairs.length; i += 1) {
  const pair = pairs[i];
  const num = String(i + 1).padStart(2, "0");

  const englishText = `${num} ${String(pair.en || "")
   .replace(/\s+/g, " ")
   .trim()}`;
  const koreanText = String(pair.ko || "")
   .replace(/\s+/g, " ")
   .trim();

  doc.setFontSize(englishFontSize);
  const englishLines = doc.splitTextToSize(englishText, contentWidth);

  doc.setFontSize(koreanFontSize);
  const koreanLines = doc.splitTextToSize(koreanText, contentWidth);

  const itemHeight = englishLines.length * lineHeight + blockGap + koreanLines.length * lineHeight + itemGap;

  ensurePageSpace(itemHeight);

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(englishFontSize);
  doc.text(englishLines, marginLeft, y);
  y += englishLines.length * lineHeight + blockGap;

  doc.setTextColor(80, 80, 80);
  doc.setFontSize(koreanFontSize);
  doc.text(koreanLines, marginLeft, y);
  y += koreanLines.length * lineHeight + itemGap;
 }

 doc.save(filename);
};
