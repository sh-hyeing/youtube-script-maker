import { NextResponse } from "next/server";
import { fetchTranscript, listLanguages } from "youtube-transcript-plus";
import { ProxyAgent } from "undici";

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

function extractVideoId(input) {
 const value = String(input || "").trim();

 if (!value) {
  throw new Error("EMPTY_URL");
 }

 if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
  return value;
 }

 const url = new URL(normalizeYoutubeUrl(value));
 const videoId = url.searchParams.get("v");

 if (!videoId) {
  throw new Error("INVALID_YOUTUBE_URL");
 }

 return videoId;
}

const proxyUrl = process.env.YOUTUBE_PROXY_URL || "";
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

function getFetchOptions(lang) {
 return {
  headers: {
   "User-Agent":
    process.env.YOUTUBE_TRANSCRIPT_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
   "Accept-Language": lang ? `${lang},en;q=0.9` : "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
   Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
   "Cache-Control": "no-cache",
   Pragma: "no-cache",
  },
  cache: "no-store",
  ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
 };
}

async function proxyAwareFetch(url, init = {}, lang) {
 const mergedHeaders = {
  ...(getFetchOptions(lang).headers || {}),
  ...(init.headers || {}),
 };

 return fetch(url, {
  ...init,
  ...getFetchOptions(lang),
  headers: mergedHeaders,
 });
}

function createRequestInit(lang) {
 const userAgent =
  process.env.YOUTUBE_TRANSCRIPT_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

 return {
  userAgent,
  retries: 3,
  retryDelay: 1000,
  lang,
  videoFetch: async ({ url, userAgent: runtimeUserAgent }) => {
   return proxyAwareFetch(
    url,
    {
     method: "GET",
     headers: {
      "User-Agent": runtimeUserAgent || userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
     },
    },
    lang,
   );
  },
  playerFetch: async ({ url, method, body, headers, userAgent: runtimeUserAgent }) => {
   return proxyAwareFetch(
    url,
    {
     method,
     body,
     headers: {
      ...headers,
      "User-Agent": runtimeUserAgent || userAgent,
      Accept: "application/json,text/plain,*/*",
     },
    },
    lang,
   );
  },
  transcriptFetch: async ({ url, userAgent: runtimeUserAgent }) => {
   return proxyAwareFetch(
    url,
    {
     method: "GET",
     headers: {
      "User-Agent": runtimeUserAgent || userAgent,
      Accept: "application/json,text/xml,application/xml;q=0.9,*/*;q=0.8",
     },
    },
    lang,
   );
  },
 };
}

async function fetchTranscriptOnce(videoIdOrUrl, lang) {
 const result = await fetchTranscript(videoIdOrUrl, createRequestInit(lang));
 const segments = Array.isArray(result) ? result : result?.segments;

 if (Array.isArray(segments) && segments.length > 0) {
  return { transcript: segments, lang: lang || "auto", via: proxyAgent ? "proxy" : "direct" };
 }

 throw new Error("EMPTY_TRANSCRIPT");
}

async function fetchTranscriptWithFallback(videoIdOrUrl) {
 const candidates = ["ko", "en", "ja", "en-US", undefined];
 const errors = [];

 for (const lang of candidates) {
  try {
   return await fetchTranscriptOnce(videoIdOrUrl, lang);
  } catch (error) {
   errors.push({
    lang: lang || "auto",
    via: proxyAgent ? "proxy" : "direct",
    message: error instanceof Error ? error.message : "UNKNOWN_ERROR",
   });
  }
 }

 let availableLanguages = [];

 try {
  availableLanguages = await listLanguages(videoIdOrUrl, createRequestInit(undefined));
 } catch (error) {
  errors.push({
   lang: "listLanguages",
   via: proxyAgent ? "proxy" : "direct",
   message: error instanceof Error ? error.message : "UNKNOWN_ERROR",
  });
 }

 const availableCodes = Array.isArray(availableLanguages) ? availableLanguages.map((item) => item.languageCode).filter(Boolean) : [];

 for (const lang of availableCodes.slice(0, 5)) {
  try {
   return await fetchTranscriptOnce(videoIdOrUrl, lang);
  } catch (error) {
   errors.push({
    lang,
    via: proxyAgent ? "proxy" : "direct",
    message: error instanceof Error ? error.message : "UNKNOWN_ERROR",
   });
  }
 }

 const finalError = new Error("TRANSCRIPT_FETCH_FAILED");
 finalError.cause = { errors };
 throw finalError;
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

  const videoId = extractVideoId(normalizedUrl);
  const { transcript, lang, via } = await fetchTranscriptWithFallback(videoId);

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
    detectedLang: lang,
    fetchedVia: via,
   },
   { status: 200 },
  );
 } catch (error) {
  const details = error instanceof Error ? error.message : "UNKNOWN_TRANSCRIPT_ERROR";
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : null;

  return NextResponse.json(
   {
    error: "자막을 가져오지 못했습니다. 자막이 비활성화된 영상이거나 클라우드 환경 요청이 차단되었을 수 있습니다.",
    details,
    diagnostics: cause,
   },
   { status: 500 },
  );
 }
}
