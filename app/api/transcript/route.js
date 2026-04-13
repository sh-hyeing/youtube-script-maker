import { NextResponse } from "next/server";
import { fetchTranscript } from "youtube-transcript";

function normalizeYoutubeUrl(input) {
 const value = String(input || "").trim();

 if (!value) {
  throw new Error("EMPTY_URL");
 }

 let url;

 try {
  url = new URL(value);
 } catch {
  throw new Error("INVALID_URL");
 }

 const host = url.hostname.replace(/^www\./, "");

 if (!["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
  throw new Error("INVALID_YOUTUBE_URL");
 }

 if (host === "youtu.be") {
  const id = url.pathname.replace("/", "").trim();
  if (!id) {
   throw new Error("INVALID_YOUTUBE_URL");
  }
  return `https://www.youtube.com/watch?v=${id}`;
 }

 const videoId = url.searchParams.get("v");
 if (!videoId) {
  throw new Error("INVALID_YOUTUBE_URL");
 }

 return `https://www.youtube.com/watch?v=${videoId}`;
}

function formatTimestamp(offset) {
 const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
 const totalSeconds = Math.floor(safeOffset / 1000);
 const hours = Math.floor(totalSeconds / 3600);
 const minutes = Math.floor((totalSeconds % 3600) / 60);
 const seconds = totalSeconds % 60;

 if (hours > 0) {
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
 }

 return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function buildTranscriptText(transcript) {
 return transcript
  .map((item) => `[${formatTimestamp(item.offset)}] ${String(item.text || "").trim()}`)
  .filter((line) => line.replace(/\[[^\]]+\]\s*/, "").trim().length > 0)
  .join("\n");
}

function chunkTextByLine(text, maxLength = 2800) {
 if (!text.trim()) return [];

 const lines = text.split("\n");
 const chunks = [];
 let current = "";

 for (const line of lines) {
  const candidate = current ? `${current}\n${line}` : line;

  if (candidate.length <= maxLength) {
   current = candidate;
   continue;
  }

  if (current) {
   chunks.push(current);
   current = line;
   continue;
  }

  let start = 0;
  while (start < line.length) {
   chunks.push(line.slice(start, start + maxLength));
   start += maxLength;
  }
 }

 if (current) {
  chunks.push(current);
 }

 return chunks;
}

export async function POST(req) {
 try {
  let body;

  try {
   body = await req.json();
  } catch {
   return NextResponse.json({ error: "JSON 본문을 읽지 못했습니다." }, { status: 400 });
  }

  const videoUrl = body && typeof body === "object" && typeof body.videoUrl === "string" ? body.videoUrl : "";

  let normalizedUrl;

  try {
   normalizedUrl = normalizeYoutubeUrl(videoUrl);
  } catch (error) {
   const message = error instanceof Error ? error.message : "INVALID_REQUEST";

   if (message === "EMPTY_URL") {
    return NextResponse.json({ error: "유튜브 링크가 필요합니다." }, { status: 400 });
   }

   if (message === "INVALID_URL" || message === "INVALID_YOUTUBE_URL") {
    return NextResponse.json({ error: "올바른 유튜브 링크를 입력해 주세요." }, { status: 400 });
   }

   return NextResponse.json({ error: "요청을 처리할 수 없습니다." }, { status: 400 });
  }

  const transcript = await fetchTranscript(normalizedUrl);

  if (!Array.isArray(transcript) || transcript.length === 0) {
   return NextResponse.json({ error: "자막 데이터가 비어 있습니다." }, { status: 404 });
  }

  const transcriptText = buildTranscriptText(transcript);
  const transcriptChunks = chunkTextByLine(transcriptText, 2800);

  if (!transcriptText.trim() || transcriptChunks.length === 0) {
   return NextResponse.json({ error: "가공 가능한 자막 텍스트가 없습니다." }, { status: 404 });
  }

  return NextResponse.json(
   {
    normalizedUrl,
    transcriptText,
    transcriptChunks,
    chunkCount: transcriptChunks.length,
   },
   { status: 200 },
  );
 } catch (error) {
  const details = error instanceof Error ? error.message : "UNKNOWN_TRANSCRIPT_ERROR";

  return NextResponse.json(
   {
    error: "자막을 가져오지 못했습니다. 자막이 비활성화된 영상이거나 요청이 차단되었을 수 있습니다.",
    details,
   },
   { status: 500 },
  );
 }
}
