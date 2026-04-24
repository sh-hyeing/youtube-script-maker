import { NextResponse } from "next/server";

export const runtime = "nodejs";

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

function getRailwayBaseUrl() {
 const value = String(process.env.YTDLP_TRANSCRIPT_SERVER_URL || "").trim();

 if (!value) {
  throw new Error("MISSING_TRANSCRIPT_SERVER_URL");
 }

 return value.replace(/\/+$/, "");
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
  const lang = body && typeof body === "object" && typeof body.lang === "string" ? body.lang.trim() : "";

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

  let railwayBaseUrl;

  try {
   railwayBaseUrl = getRailwayBaseUrl();
  } catch (error) {
   const message = error instanceof Error ? error.message : "CONFIG_ERROR";

   if (message === "MISSING_TRANSCRIPT_SERVER_URL") {
    return NextResponse.json({ error: "자막 서버 주소가 설정되지 않았습니다." }, { status: 500 });
   }

   return NextResponse.json({ error: "자막 서버 설정을 확인할 수 없습니다." }, { status: 500 });
  }

  const upstreamResponse = await fetch(`${railwayBaseUrl}/transcript`, {
   method: "POST",
   headers: {
    "Content-Type": "application/json",
   },
   cache: "no-store",
   body: JSON.stringify({
    videoUrl: normalizedUrl,
    ...(lang ? { lang } : {}),
   }),
  });

  const rawText = await upstreamResponse.text();

  let data = null;

  try {
   data = rawText ? JSON.parse(rawText) : null;
  } catch {
   data = null;
  }

  if (!upstreamResponse.ok) {
   const upstreamError = data && typeof data === "object" && typeof data.error === "string" ? data.error : "UPSTREAM_TRANSCRIPT_ERROR";
   const upstreamDetails = data && typeof data === "object" && "details" in data ? data.details : rawText;

   if (upstreamResponse.status === 404) {
    return NextResponse.json(
     {
      error: "자막을 찾지 못했습니다.",
      details: upstreamDetails,
      upstreamError,
     },
     { status: 404 },
    );
   }

   if (upstreamResponse.status === 429) {
    return NextResponse.json(
     {
      error: "요청이 많아 잠시 후 다시 시도해야 합니다.",
      details: upstreamDetails,
      upstreamError,
     },
     { status: 429 },
    );
   }

   return NextResponse.json(
    {
     error: "외부 자막 서버 요청에 실패했습니다.",
     details: upstreamDetails,
     upstreamError,
     status: upstreamResponse.status,
    },
    { status: upstreamResponse.status || 500 },
   );
  }

  const needsClientStt = Boolean(data && typeof data === "object" && "needsClientStt" in data && data.needsClientStt === true);

  const transcriptText =
   data && typeof data === "object" && typeof data.transcript === "string"
    ? data.transcript
    : data && typeof data === "object" && typeof data.text === "string"
      ? data.text
      : "";

  if (needsClientStt) {
   return NextResponse.json(
    {
     normalizedUrl,
     transcriptText: "",
     transcriptChunks: [],
     chunkCount: 0,
     detectedLang: data && typeof data === "object" && typeof data.lang === "string" ? data.lang : lang || "auto",
     fetchedVia: data && typeof data === "object" && typeof data.source === "string" ? data.source : "railway-ytdlp",
     rawVtt: "",
     fileName: data && typeof data === "object" && typeof data.fileName === "string" ? data.fileName : "",
     title: data && typeof data === "object" && typeof data.title === "string" ? data.title : "",
     transcriptSource: data && typeof data === "object" && typeof data.transcriptSource === "string" ? data.transcriptSource : "client_gemini_stt",
     subtitleAvailability:
      data && typeof data === "object" && typeof data.subtitleAvailability === "string" ? data.subtitleAvailability : "auto_only",
     needsClientStt: true,
     audioUrl: data && typeof data === "object" && typeof data.audioUrl === "string" ? data.audioUrl : "",
     audioMimeType: data && typeof data === "object" && typeof data.audioMimeType === "string" ? data.audioMimeType : "",
     expiresAt: data && typeof data === "object" && typeof data.expiresAt === "number" ? data.expiresAt : 0,
    },
    { status: 200 },
   );
  }

  if (!transcriptText.trim()) {
   return NextResponse.json({ error: "가공 가능한 자막 텍스트가 없습니다." }, { status: 404 });
  }

  const transcriptChunks = chunkTextByLine(transcriptText, 2800);

  if (transcriptChunks.length === 0) {
   return NextResponse.json({ error: "가공 가능한 자막 청크를 만들지 못했습니다." }, { status: 404 });
  }

  return NextResponse.json(
   {
    normalizedUrl,
    transcriptText,
    transcriptChunks,
    chunkCount: transcriptChunks.length,
    detectedLang: data && typeof data === "object" && typeof data.lang === "string" ? data.lang : lang || "auto",
    fetchedVia: data && typeof data === "object" && typeof data.source === "string" ? data.source : "railway-ytdlp",
    rawVtt: data && typeof data === "object" && typeof data.rawVtt === "string" ? data.rawVtt : "",
    fileName: data && typeof data === "object" && typeof data.fileName === "string" ? data.fileName : "",
    title: data && typeof data === "object" && typeof data.title === "string" ? data.title : "",
    transcriptSource: data && typeof data === "object" && typeof data.transcriptSource === "string" ? data.transcriptSource : "official_subtitle",
    subtitleAvailability: data && typeof data === "object" && typeof data.subtitleAvailability === "string" ? data.subtitleAvailability : "official",
    needsClientStt: false,
    audioUrl: "",
    audioMimeType: "",
    expiresAt: 0,
   },
   { status: 200 },
  );
 } catch (error) {
  const details = error instanceof Error ? error.message : "UNKNOWN_TRANSCRIPT_ERROR";

  return NextResponse.json(
   {
    error: "자막을 가져오지 못했습니다.",
    details,
   },
   { status: 500 },
  );
 }
}
