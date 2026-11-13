import { readFile, writeFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";

const API = "https://hrrydoc.vercel.app";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastRequestAt = 0;
let blockedUntil = 0;
const MIN_GAP_MS = 500;
let requestQueue = Promise.resolve();
let progressQueue = Promise.resolve();
async function persistProgress() {
  const totals = Object.values(result.batches).reduce((sum, item) => ({
    batches: sum.batches + 1,
    subjects: sum.subjects + (item.subjects || []).length,
    videos: sum.videos + (item.totals?.videos || 0),
    pdfs: sum.pdfs + (item.totals?.pdfs || 0)
  }), { batches: 0, subjects: 0, videos: 0, pdfs: 0 });
  if (totals.subjects + totals.videos + totals.pdfs === 0) {
    console.warn("No original content collected yet; preserving existing snapshot.");
    return;
  }
  const snapshot = JSON.stringify({ ...result, totals });
  progressQueue = progressQueue.then(() => writeFile("public/disha-content.json", snapshot));
  await progressQueue;
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data","subjects","chapters","items","results","folders","lectures","pdfs","subFolders","list","records"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ["data","result","payload"]) {
    if (value[key] && typeof value[key] === "object") {
      const found = rows(value[key]);
      if (found.length) return found;
    }
  }
  return [];
}
const id = x => String(x?.id ?? x?.folder_id ?? x?.folderId ?? x?.chapter_id ?? x?.subject_id ?? x?.lecture_id ?? x?.file_id ?? "");
const title = x => String(x?.title ?? x?.Title ?? x?.name ?? x?.subject_name ?? x?.topic_name ?? x?.file_name ?? "Untitled");
const first = (...values) => values.find(v => v !== undefined && v !== null && v !== "");

async function get(path) {
  const task = requestQueue.then(async () => {
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const waitUntil = Math.max(blockedUntil, lastRequestAt + MIN_GAP_MS);
      if (waitUntil > Date.now()) await sleep(waitUntil - Date.now());
      lastRequestAt = Date.now();
      try {
        const response = await fetch(API + path, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(25000)
        });
        const raw = await response.text();
        let json;
        try { json = JSON.parse(raw); } catch {
          const error = new Error("Non-JSON response (HTTP " + response.status + "): " + raw.slice(0,120));
          error.status = response.status;
          error.retryAfter = response.headers.get("retry-after") || "";
          throw error;
        }
        if (!response.ok || json?.success === false) {
          const error = new Error(String(json?.error || json?.message || ("HTTP " + response.status)));
          error.status = response.status;
          error.retryAfter = response.headers.get("retry-after") || "";
          throw error;
        }
        return json;
      } catch (error) {
        lastError = error;
        const rateLimited = error.status === 429 || /429|rate.?limit|too many requests/i.test(error.message || "");
        if (attempt === 5) break;
        let retryMs = 0;
        if (error.retryAfter) {
          const seconds = Number(error.retryAfter);
          retryMs = Number.isFinite(seconds) && seconds > 0
            ? seconds * 1000
            : Math.max(0, Date.parse(error.retryAfter) - Date.now());
        }
        const delay = rateLimited
          ? Math.max(retryMs, Math.min(90000, 15000 * attempt))
          : Math.min(20000, 3000 * attempt);
        if (rateLimited) blockedUntil = Date.now() + delay;
        console.warn("Retry API", path, "attempt", attempt, "after", delay, "ms:", error.message);
        await sleep(delay);
      }
    }
    throw lastError || new Error("API request failed");
  });
  requestQueue = task.catch(() => {});
  return task;
}

function decodeAppx(value) {
  if (!value || typeof value !== "string" || !value.includes(":") || value.startsWith("http")) return String(value || "").trim();
  try {
    const [cipher, iv] = value.split(":");
    const decipher = createDecipheriv("aes-128-cbc", Buffer.from("638udh3829162018"), Buffer.from(iv, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(cipher, "base64")), decipher.final()]).toString("utf8").trim();
  } catch { return ""; }
}
function youtubeId(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  return text.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/)?.[1] || "";
}
function videoInfo(item) {
  const qualities = [];
  let streamUrl = "", downloadUrl = "", videoId = "";
  for (const link of (Array.isArray(item?.encrypted_links) ? item.encrypted_links : [])) {
    const url = decodeAppx(link.path) || decodeAppx(link.backup_url);
    if (url && /^https?:\/\//i.test(url) && !/\/hls-drm-/i.test(url)) {
      qualities.push({ quality: String(link.quality || "Auto"), url });
      streamUrl ||= url;
    }
  }
  for (const key of ["download_link","download_link2","download_url_higher_version","download_url_lower_version","recording_hls","file_link"]) {
    const url = decodeAppx(item?.[key]);
    if (!url) continue;
    const id = youtubeId(url);
    if (id) videoId ||= id;
    else if (/^https?:\/\//i.test(url) && !/\/hls-drm-/i.test(url)) {
      if (key === "download_link" && !/\.m3u8(?:$|\?)/i.test(url)) downloadUrl ||= url;
      streamUrl ||= url;
      if (!qualities.some(q => q.url === url)) qualities.push({ quality: key === "file_link" ? "Default" : "Direct", url });
    }
  }
  videoId ||= youtubeId(decodeAppx(item?.video_id));
  if (!videoId) videoId = youtubeId(streamUrl);
  const embedUrl = videoId ? "https://www.youtube.com/embed/" + videoId + "?playsinline=1&rel=0" : "";
  const token = String(item?.video_player_token || "").trim();
  let playerUrl = "";
  if (token && token !== "1234") {
    const raw = String(item?.video_player_url || "");
    playerUrl = /token=$/.test(raw) && raw.includes("combined-img-player")
      ? raw + encodeURIComponent(token)
      : "https://appx-play.classx.co.in/combined-img-player?isMobile=true&token=" + encodeURIComponent(token);
  }
  return { streamUrl, downloadUrl, embedUrl: embedUrl || playerUrl, videoId, qualities };
}

function normalizeResource(item, kind) {
  const video = kind === "video";
  const derived = video ? videoInfo(item) : {};
  return {
    id: id(item),
    title: title(item),
    duration: String(item?.duration ?? ""),
    thumbnail: String(first(item?.thumbnail, item?.image, item?.image_url, "")),
    kind,
    streamUrl: String(first(item?.streamUrl, item?.stream_url, item?.url, derived.streamUrl, "")),
    downloadUrl: String(first(item?.downloadUrl, item?.download_url, derived.downloadUrl, "")),
    embedUrl: String(first(item?.embedUrl, item?.embed_url, item?.playerUrl, item?.player_url, derived.embedUrl, "")),
    videoId: String(first(item?.videoId, item?.video_id, derived.videoId, "")),
    qualities: Array.isArray(item?.qualities) ? item.qualities : (derived.qualities || []),
    pdfUrl: decodeAppx(String(first(item?.pdfUrl, item?.pdf_url, item?.pdf_link, item?.file_link, item?.download_link, ""))),
    downloadUrl: decodeAppx(String(first(item?.downloadUrl, item?.download_url, item?.pdfUrl, item?.pdf_url, item?.pdf_link, item?.file_link, item?.download_link, ""))),
    pdfKey: String(first(item?.pdfKey, item?.pdf_key, item?.pdf_encryption_key, item?.file_key, "")),
    raw: item
  };
}

async function walkFolder(batchId, subjectId, chapterId, seen, depth = 0) {
  const key = batchId + ":" + subjectId + ":" + chapterId;
  if (!chapterId || seen.has(key) || depth > 10 || seen.size > 1800) {
    return { id: chapterId, folders: [], videos: [], pdfs: [] };
  }
  seen.add(key);
  const query = new URLSearchParams({ batchId, subjectId, chapterId });
  const response = await get("/api/disha/lectures?" + query);
  const data = response?.data && typeof response.data === "object" && !Array.isArray(response.data) ? response.data : response;
  const flatRows = Array.isArray(response?.data) ? response.data : rows(response?.data ?? response);
  const typeOf = item => String(item?.material_type ?? item?.type ?? item?.content_type ?? item?.file_type ?? "").trim().toUpperCase();
  const isFolder = item => typeOf(item) === "FOLDER" || typeOf(item) === "DIR";
  const isPdf = item => /PDF|DOCUMENT|NOTE/.test(typeOf(item)) || Boolean(first(item?.pdf_link, item?.pdf_link2, item?.pdf_url, item?.pdfUrl)) && !first(item?.video_id, item?.video_player_token, item?.asset);
  const videosRaw = Array.isArray(response?.lectures) ? response.lectures : rows(data?.lectures).length ? rows(data.lectures) : flatRows.filter(item => !isFolder(item) && !isPdf(item));
  const pdfsRaw = Array.isArray(response?.pdfs) ? response.pdfs : rows(data?.pdfs).length ? rows(data.pdfs) : flatRows.filter(isPdf);
  const children = Array.isArray(response?.subFolders) ? response.subFolders : rows(data?.subFolders).length ? rows(data.subFolders) : flatRows.filter(isFolder);
  const folders = [];
  for (const child of children) {
    const childId = id(child);
    if (!childId) continue;
    try {
      const nested = await walkFolder(batchId, subjectId, childId, seen, depth + 1);
      folders.push({ id: childId, title: title(child), ...nested });
    } catch (error) {
      console.warn("Folder load failed", batchId, childId, error.message);
      folders.push({ id: childId, title: title(child), folders: [], videos: [], pdfs: [], loadError: error.message });
    }
  }
  const videos = [];
  for (const item of videosRaw) {
    const enriched = normalizeResource(item, "video");
    if (enriched.id) videos.push(enriched);
  }
  const pdfs = pdfsRaw.map(item => normalizeResource(item, "pdf")).filter(item => item.id || item.pdfUrl || item.pdfKey);
  return { id: chapterId, folders, videos, pdfs };
}

async function buildBatch(batch) {
  const batchId = String(first(batch?.id, batch?.batch_id, batch?.course_id, batch?.batchId, ""));
  const subjectResponse = await get("/api/disha/subjects?" + new URLSearchParams({ batchId }));
  const subjectRows = rows(subjectResponse?.data ?? subjectResponse);
  const subjects = [];
  for (const subject of subjectRows) {
    const subjectId = id(subject);
    if (!subjectId) continue;
    try {
      const chapterResponse = await get("/api/disha/chapters?" + new URLSearchParams({ batchId, subjectId }));
      const chapterRows = rows(chapterResponse?.data ?? chapterResponse);
      const chapters = [];
      for (const chapter of chapterRows) {
        const chapterId = id(chapter);
        if (!chapterId) continue;
        try {
          const content = await walkFolder(batchId, subjectId, chapterId, new Set());
          chapters.push({ id: chapterId, title: title(chapter), ...content });
        } catch (error) {
          console.warn("Chapter load failed", batchId, chapterId, error.message);
          chapters.push({ id: chapterId, title: title(chapter), folders: [], videos: [], pdfs: [], loadError: error.message });
        }
      }
      subjects.push({ id: subjectId, title: title(subject), chapters });
    } catch (error) {
      console.warn("Subject load failed", batchId, subjectId, error.message);
      subjects.push({ id: subjectId, title: title(subject), chapters: [], loadError: error.message });
    }
  }
  const totals = subjects.reduce((sum, subject) => {
    for (const chapter of subject.chapters) {
      const count = node => {
        sum.videos += (node.videos || []).length;
        sum.pdfs += (node.pdfs || []).length;
        (node.folders || []).forEach(count);
      };
      count(chapter);
    }
    return sum;
  }, { videos: 0, pdfs: 0 });
  console.log("Batch complete", batchId, "subjects", subjects.length, "videos", totals.videos, "pdfs", totals.pdfs);
  return { subjects, totals };
}

const source = JSON.parse(await readFile("public/disha-batches.json", "utf8"));
const batches = rows(source?.data ?? source);
let previousSnapshot = {};
try {
  previousSnapshot = JSON.parse(await readFile("public/disha-content.json", "utf8"));
} catch {}
const result = {
  ...previousSnapshot,
  success: true,
  generatedAt: new Date().toISOString(),
  batches: { ...(previousSnapshot.batches || {}) },
  errors: {}
};
let nextBatch = 0;
async function batchWorker(workerId) {
  while (true) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    const batch = batches[index];
    const batchId = String(first(batch?.id, batch?.batch_id, batch?.course_id, batch?.batchId, ""));
    if (!batchId) continue;
    console.log("Fetching Disha content", batchId, "worker", workerId);
    try {
      const fresh = await buildBatch(batch);
      const hasFreshContent = (fresh.subjects || []).length > 0;
      const previous = result.batches[batchId];
      if (hasFreshContent || !previous || !(previous.subjects || []).length) {
        result.batches[batchId] = fresh;
      } else {
        console.warn("API returned zero subjects; preserving previous valid snapshot for batch", batchId);
      }
      delete result.errors[batchId];
    } catch (error) {
      if (!result.batches[batchId]) {
        result.batches[batchId] = { subjects: [], totals: { videos: 0, pdfs: 0 } };
      }
      result.errors[batchId] = error.message;
      console.warn("Batch content failed after retries", batchId, error.message);
    }
    // Persist progress so the workflow can still publish completed batches.
    await persistProgress();
  }
}
await batchWorker(1);
const totals = Object.values(result.batches).reduce((sum, batch) => {
  sum.subjects += (batch.subjects || []).length;
  sum.videos += batch.totals?.videos || 0;
  sum.pdfs += batch.totals?.pdfs || 0;
  return sum;
}, { subjects: 0, videos: 0, pdfs: 0 });
result.totals = { batches: Object.keys(result.batches).length, ...totals, failedBatches: Object.keys(result.errors).length };
if (result.totals.subjects + result.totals.videos + result.totals.pdfs > 0) {
  await writeFile("public/disha-content.json", JSON.stringify(result));
  console.log("Disha content snapshot complete", JSON.stringify(result.totals));
} else {
  console.warn("No study content was returned by the original API. Not publishing an empty snapshot; any existing valid snapshot is preserved.");
}
if (result.totals.failedBatches > 0) console.warn("Publishing completed batches; failed batches can be retried on the next scheduled build.");
