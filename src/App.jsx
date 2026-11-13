import React, { useEffect, useMemo, useRef, useState } from "react";

const BASE = import.meta.env.BASE_URL;
const API_URL = "https://hrrydoc.vercel.app/api/disha/batches";
const TELEGRAM_URL = "https://t.me/HIMAPPS";
const DishaAPI = "https://hrrydoc.vercel.app";
const CLASSX_API = "https://dishaonlineclassesapi.classx.co.in";
const classxCache = new Map();
const classxInflight = new Map();
let classxLastCall = 0;
const classxCourseId = value => {
  const id = String(value || "").trim();
  return id === "88" ? "58" : id === "91" ? "61" : id;
};
async function classxGet(path, courseId = "", ttl = 45000) {
  const key = String(courseId || "public") + ":" + path;
  const cached = classxCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  if (classxInflight.has(key)) return classxInflight.get(key);
  const task = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const gap = Date.now() - classxLastCall;
      if (gap < 450) await new Promise(resolve => setTimeout(resolve, 450 - gap));
      classxLastCall = Date.now();
      try {
        let credentials = null;
        try { credentials = JSON.parse(localStorage.getItem("disha_user_creds") || "null"); } catch {}
        const headers = {
          "Auth-Key": "appxapi",
          "Client-Service": "Appx",
          source: "website",
          ...(credentials?.token && credentials?.userId ? { Authorization: credentials.token, "User-ID": String(credentials.userId) } : {})
        };
        const response = await fetch(CLASSX_API + path, { headers, cache: "no-store" });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error("ClassX API HTTP " + response.status);
          if (attempt < 4) { await new Promise(resolve => setTimeout(resolve, 600 * attempt)); continue; }
          break;
        }
        if (!response.ok) throw new Error("ClassX API HTTP " + response.status);
        const raw = await response.text();
        if (raw.trim().startsWith("Too Many Requests")) {
          lastError = new Error("ClassX API rate limit");
          if (attempt < 4) { await new Promise(resolve => setTimeout(resolve, 700 * attempt)); continue; }
          break;
        }
        const json = JSON.parse(raw);
        if (ttl > 0 && json?.data && (Array.isArray(json.data) ? json.data.length : typeof json.data === "object")) {
          classxCache.set(key, { data: json, expires: Date.now() + ttl });
        }
        return json;
      } catch (error) {
        lastError = error;
        if (attempt === 4 || /Failed to fetch|Load failed|NetworkError/i.test(error.message || "")) break;
        await new Promise(resolve => setTimeout(resolve, 350 * attempt));
      }
    }
    if (/Failed to fetch|Load failed|NetworkError/i.test(lastError?.message || "")) {
      throw new Error("ClassX API browser access/CORS blocked. " + lastError.message);
    }
    throw lastError || new Error("ClassX API unavailable");
  })().finally(() => classxInflight.delete(key));
  classxInflight.set(key, task);
  return task;
}
async function loadClassxSubjects(batchId) {
  const courseId = classxCourseId(batchId);
  let folders = [];
  const cachedRoot = classxCache.get("root-folder:" + courseId)?.data;
  if (cachedRoot) folders = cachedRoot;
  if (!folders.length) {
    const response = await classxGet("/get/folder_contentsv2?course_id=" + encodeURIComponent(courseId) + "&parent_id=-1", courseId, 1800000);
    const rows = Array.isArray(response?.data) ? response.data : [];
    folders = rows.filter(item => String(item?.material_type || "").toUpperCase() === "FOLDER");
    if (folders.length === 1 && rows.length === 1) {
      const rootId = String(folders[0].id || "");
      if (rootId) {
        const nested = await classxGet("/get/folder_contentsv2?course_id=" + encodeURIComponent(courseId) + "&parent_id=" + encodeURIComponent(rootId), courseId);
        const sub = (Array.isArray(nested?.data) ? nested.data : []).filter(item => String(item?.material_type || "").toUpperCase() === "FOLDER");
        if (sub.length) folders = sub;
      }
    }
    classxCache.set("root-folder:" + courseId, { data: folders, expires: Date.now() + 1800000 });
  }
  return folders.map(item => ({
    id: String(item.id || ""),
    title: String(item.Title || item.title || item.subject_name || item.name || "Untitled"),
    image: item.thumbnail || item.subject_logo || ""
  })).filter(item => item.id);
}
async function loadClassxChapters(batchId, subjectId) {
  const courseId = classxCourseId(batchId);
  const response = await classxGet("/get/folder_contentsv2?course_id=" + encodeURIComponent(courseId) + "&parent_id=" + encodeURIComponent(subjectId), courseId);
  const rows = Array.isArray(response?.data) ? response.data : [];
  const folders = rows.filter(item => String(item?.material_type || "").toUpperCase() === "FOLDER");
  const files = rows.filter(item => String(item?.material_type || "").toUpperCase() !== "FOLDER");
  const chapters = folders.map(item => ({
    id: String(item.id || ""),
    title: String(item.Title || item.title || item.topic_name || item.name || "Untitled"),
    image: item.thumbnail || ""
  })).filter(item => item.id);
  if (files.length) chapters.unshift({
    id: String(subjectId),
    title: "Lectures & Notes",
    image: ""
  });
  return chapters;
}
async function normalizeClassxResource(item, kind) {
  const mapped = {
    ...item,
    id: String(item?.id || item?.lecture_id || item?.file_id || ""),
    title: String(item?.Title || item?.title || item?.name || "Untitled"),
    pdfUrl: item?.pdfUrl || item?.pdf_url || item?.pdf_link || item?.pdf_link2 || "",
    file_link: item?.file_link || "",
    video_id: item?.video_id || "",
    encrypted_links: Array.isArray(item?.encrypted_links) ? item.encrypted_links : []
  };
  const normalized = await normalizeApiResource(mapped, kind);
  const pdfRaw = item?.pdf_link || item?.pdf_link2 || item?.pdf_url || item?.file_link || "";
  const pdfUrl = await decodeAppx(pdfRaw);
  const pdfKey = await decodeAppx(item?.pdf_encryption_key || item?.pdf2_encryption_key || "");
  return {
    ...normalized,
    id: mapped.id,
    title: mapped.title,
    pdfUrl: /^https?:\/\//i.test(pdfUrl) ? pdfUrl : normalized.pdfUrl,
    pdfKey,
    isPdfEncrypted: String(item?.is_pdf_encrypted ?? item?.is_pdf2_encrypted ?? "0") !== "0"
  };
}
async function loadClassxFolderTree(batchId, subjectId, chapterId, depth = 0, seen = new Set()) {
  const courseId = classxCourseId(batchId);
  if (!chapterId || depth > 10 || seen.has(String(chapterId))) return { id: chapterId, folders: [], videos: [], pdfs: [] };
  seen.add(String(chapterId));
  const response = await classxGet("/get/folder_contentsv2?course_id=" + encodeURIComponent(courseId) + "&parent_id=" + encodeURIComponent(chapterId), courseId);
  const rows = Array.isArray(response?.data) ? response.data : [];
  const folderRows = rows.filter(item => String(item?.material_type || "").toUpperCase() === "FOLDER");
  const fileRows = rows.filter(item => String(item?.material_type || "").toUpperCase() !== "FOLDER");
  const folders = folderRows.map(folder => ({
    id: String(folder.id || ""),
    title: String(folder.Title || folder.title || folder.name || "Folder"),
    folders: [],
    videos: [],
    pdfs: [],
    _loaded: false
  })).filter(folder => folder.id);
  const videos = [];
  const pdfs = [];
  for (const item of fileRows) {
    const kind = String(item?.material_type || "").toUpperCase();
    if (kind === "PDF" || (!item?.video_id && !item?.file_link && (item?.pdf_link || item?.pdf_link2))) {
      pdfs.push(await normalizeClassxResource(item, "pdf"));
    } else {
      videos.push(await normalizeClassxResource(item, "video"));
    }
  }
  return { id: chapterId, folders, videos: videos.filter(item => item.id), pdfs: pdfs.filter(item => item.id || item.pdfUrl) };
}
const apiRows = value => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data","subjects","chapters","items","results","folders","lectures","pdfs","subFolders","list","records"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ["result","payload"]) if (value[key] && typeof value[key] === "object") {
    const found = apiRows(value[key]); if (found.length) return found;
  }
  return [];
};
const apiId = x => String(x?.id ?? x?.folder_id ?? x?.folderId ?? x?.chapter_id ?? x?.subject_id ?? x?.lecture_id ?? x?.file_id ?? "");
const apiTitle = x => String(x?.title ?? x?.Title ?? x?.name ?? x?.subject_name ?? x?.topic_name ?? x?.file_name ?? "Untitled");
async function apiGet(path, timeoutMs = 5500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(DishaAPI + path, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("API HTTP " + response.status);
    const json = await response.json();
    if (json?.success === false) throw new Error(json.error || json.message || "API error");
    return json;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Original API timeout (" + timeoutMs + "ms)");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function decodeAppx(value) {
  if (!value || typeof value !== "string" || !value.includes(":") || value.startsWith("http")) return String(value || "").trim();
  try {
    const [cipher, iv] = value.split(":");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("638udh3829162018"), { name: "AES-CBC" }, false, ["decrypt"]);
    const bytes = Uint8Array.from(atob(cipher), ch => ch.charCodeAt(0));
    const ivBytes = Uint8Array.from(atob(iv), ch => ch.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, bytes)).trim();
  } catch { return ""; }
}
const ytId = value => {
  const s = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return s.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/)?.[1] || "";
};
async function normalizeApiResource(item, kind) {
  const links = Array.isArray(item?.encrypted_links) ? item.encrypted_links : [];
  const qualities = [];
  let streamUrl = "", downloadUrl = "", videoId = "";
  for (const link of links) {
    const url = await decodeAppx(link.path) || await decodeAppx(link.backup_url);
    if (/^https?:\/\//i.test(url) && !/\/hls-drm-/i.test(url)) {
      qualities.push({ quality: String(link.quality || "Auto"), url }); streamUrl ||= url;
    }
  }
  for (const key of ["download_link","download_link2","download_url_higher_version","download_url_lower_version","recording_hls","file_link"]) {
    const url = await decodeAppx(item?.[key]); if (!url) continue;
    const id = ytId(url); if (id) videoId ||= id;
    else if (/^https?:\/\//i.test(url) && !/\/hls-drm-/i.test(url)) {
      if (key === "download_link" && !/\.m3u8(?:$|\?)/i.test(url)) downloadUrl ||= url;
      streamUrl ||= url; if (!qualities.some(q => q.url === url)) qualities.push({ quality: "Direct", url });
    }
  }
  videoId ||= ytId(item?.video_id) || ytId(streamUrl);
  const token = String(item?.video_player_token || "").trim();
  const playerUrl = token && token !== "1234" ? "https://appx-play.classx.co.in/combined-img-player?isMobile=true&token=" + encodeURIComponent(token) : "";
  const pdf = await decodeAppx(item?.pdfUrl || item?.pdf_url || item?.pdf_link || item?.file_link || item?.download_link || "");
  return {
    ...item, id: apiId(item), title: apiTitle(item), kind,
    streamUrl: item?.streamUrl || item?.stream_url || item?.url || streamUrl,
    downloadUrl: item?.downloadUrl || item?.download_url || downloadUrl || (kind === "pdf" ? pdf : ""),
    embedUrl: item?.embedUrl || item?.embed_url || item?.playerUrl || item?.player_url || (videoId ? "https://www.youtube.com/embed/" + videoId + "?playsinline=1&rel=0" : playerUrl),
    videoId, qualities, pdfUrl: pdf
  };
}
async function loadFolderTree(batchId, subjectId, chapterId, depth = 0, seen = new Set()) {
  if (!chapterId || depth > 10 || seen.has(String(chapterId))) return { id: chapterId, folders: [], videos: [], pdfs: [] };
  seen.add(String(chapterId));
  try {
    const q = new URLSearchParams({ batchId, subjectId, chapterId });
    const response = await apiGet("/api/disha/lectures?" + q);
    const data = response?.data && typeof response.data === "object" ? response.data : response;
    const videosRaw = Array.isArray(response?.lectures) ? response.lectures : apiRows(data?.lectures);
    const pdfsRaw = Array.isArray(response?.pdfs) ? response.pdfs : apiRows(data?.pdfs);
    const children = Array.isArray(response?.subFolders) ? response.subFolders : apiRows(data?.subFolders);
    if (videosRaw.length || pdfsRaw.length || children.length) {
      const folders = children.map(child => ({
        id: apiId(child),
        title: apiTitle(child),
        folders: [],
        videos: [],
        pdfs: [],
        _loaded: false
      })).filter(folder => folder.id);
      const videos = await Promise.all(videosRaw.map(item => normalizeApiResource(item, "video")));
      const pdfs = await Promise.all(pdfsRaw.map(item => normalizeApiResource(item, "pdf")));
      return { id: chapterId, folders, videos: videos.filter(x => x.id), pdfs: pdfs.filter(x => x.id || x.pdfUrl) };
    }
  } catch {}
  return loadClassxFolderTree(batchId, subjectId, chapterId, depth, new Set());
}
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== "");
const txt = (value, fallback = "") => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const title = item => txt(first(item?.title, item?.name, item?.batchName, item?.batch_name, item?.label), "Untitled");
const listFrom = value => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["batches", "data", "results", "items", "courses", "payload"]) {
    if (Array.isArray(value[key])) return value[key];
    if (value[key] && typeof value[key] === "object") {
      const nested = listFrom(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
};
const isPdf = item => String(item?.kind || item?.type || "").toLowerCase() === "pdf" || Boolean(item?.pdfUrl || item?.pdf_url || item?.pdfKey);
const isVideo = item => String(item?.kind || item?.type || "").toLowerCase() === "video" || Boolean(item?.streamUrl || item?.embedUrl || item?.videoId);
function encodeAsset(id) {
  const K = [0x4b,0x72,0x1a,0x5e,0x33,0x6d,0x0f,0x41,0x28,0x59];
  const payload = Date.now().toString(36) + "." + String(id);
  const bytes = [];
  for (let i = 0; i < payload.length; i++) bytes.push(payload.charCodeAt(i) ^ K[i % K.length]);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
const cleanUrl = value => {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/^\[(.*?)\]\((https?:\/\/[^)]+)\)$/);
  return (match ? match[2] : value.trim()).replace(/&amp;/g, "&");
};
const imageOf = item => cleanUrl(first(item?.thumbnail, item?.thumbnailUrl, item?.thumbnail_url, item?.banner, item?.image, item?.imageUrl, ""));
const countTree = node => {
  let videos = (node?.videos || []).length, pdfs = (node?.pdfs || []).length;
  (node?.folders || []).forEach(folder => { const n = countTree(folder); videos += n.videos; pdfs += n.pdfs; });
  return { videos, pdfs };
};
const Icon = ({ name }) => {
  const icons = { home:"⌂", mine:"▣", dev:"✧", folder:"▰", file:"▤", video:"▶", back:"‹", search:"⌕", close:"✕" };
  return <span aria-hidden="true">{icons[name] || "•"}</span>;
};

export default function App() {
  const [batches, setBatches] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [favourites, setFavourites] = useState(() => { try { return JSON.parse(localStorage.getItem('him-disha-favourites') || '[]'); } catch { return []; } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [view, setView] = useState("home");
  const [activeBatch, setActiveBatch] = useState(null);
  const [activeSubject, setActiveSubject] = useState(null);
  const [activeChapter, setActiveChapter] = useState(null);
  const [folderStack, setFolderStack] = useState([]);
  const [tab, setTab] = useState("videos");
  const [player, setPlayer] = useState(null);
  const [contentData, setContentData] = useState(null);
  const contentPromiseRef = useRef(null);

  const ensureContent = async () => {
    if (contentData) return contentData;
    if (!contentPromiseRef.current) {
      contentPromiseRef.current = fetch(BASE + "disha-content.json", { cache: "force-cache" })
        .then(async response => {
          if (!response.ok) throw new Error("Study content snapshot HTTP " + response.status);
          const json = await response.json();
          if (!json?.batches || typeof json.batches !== "object") throw new Error("Study content snapshot format invalid");
          setContentData(json);
          return json;
        })
        .catch(error => { contentPromiseRef.current = null; throw error; });
    }
    return contentPromiseRef.current;
  };

  const load = async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(BASE + "disha-batches.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Batch snapshot HTTP " + response.status);
      const json = await response.json();
      let rows = listFrom(json?.data ?? json);
      if (!rows.length) {
        const classx = await classxGet("/get/courselistnewv2?exam_name=&start=-1&userid=0");
        rows = (Array.isArray(classx?.data) ? classx.data : [])
          .filter(item => String(item?.type || "COURSE").toUpperCase() === "COURSE" && item?.id)
          .map(item => ({
            id: String(item.id),
            name: String(item.course_name || item.name || "Untitled"),
            title: String(item.course_name || item.name || "Untitled"),
            thumbnail: item.course_thumbnail || item.thumbnail || "",
            description: item.course_description || "",
            validity: item.validity || "12 Months",
            group: item.class || item.exam_name || item.category || ""
          }));
      }
      setBatches(rows);
      if (!rows.length) setError("अभी API से कोई Batch उपलब्ध नहीं है। Retry करें।");
    } catch (snapshotError) {
      try {
        const classx = await classxGet("/get/courselistnewv2?exam_name=&start=-1&userid=0");
        const rows = (Array.isArray(classx?.data) ? classx.data : [])
          .filter(item => String(item?.type || "COURSE").toUpperCase() === "COURSE" && item?.id)
          .map(item => ({
            id: String(item.id),
            name: String(item.course_name || item.name || "Untitled"),
            title: String(item.course_name || item.name || "Untitled"),
            thumbnail: item.course_thumbnail || item.thumbnail || "",
            description: item.course_description || "",
            validity: item.validity || "12 Months",
            group: item.class || item.exam_name || item.category || ""
          }));
        setBatches(rows);
        if (!rows.length) setError("अभी API से कोई Batch उपलब्ध नहीं है। Retry करें।");
      } catch (classxError) {
        setError("Batch list load नहीं हुई: " + (classxError?.message || snapshotError?.message || "API unavailable"));
      }
    } finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    ensureContent().catch(() => {});
  }, []);

  const visibleBatches = useMemo(() => batches.filter(batch => {
    const matchesText = title(batch).toLowerCase().includes(query.toLowerCase());
    const groupText = String(first(batch?.group, batch?.class, batch?.grade, batch?.category, "")).toLowerCase();
    const matchesGroup = group === "all" || groupText.includes(group);
    return matchesText && matchesGroup;
  }), [batches, query, group]);

  const batchId = activeBatch ? String(first(activeBatch.id, activeBatch.batch_id, activeBatch.course_id, activeBatch.batchId, "")) : "";
  const savedBatches = useMemo(() => batches.filter(batch => favourites.includes(String(first(batch.id, batch.batch_id, batch.course_id, batch.batchId, "")))), [batches, favourites]);
  const toggleFavourite = batch => { const id = String(first(batch.id, batch.batch_id, batch.course_id, batch.batchId, "")); if (!id) return; setFavourites(current => { const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id]; try { localStorage.setItem("him-disha-favourites", JSON.stringify(next)); } catch {} return next; }); };
  const currentFolder = folderStack.length ? folderStack[folderStack.length - 1] : activeChapter;
  const videos = currentFolder?.videos || [];
  const pdfs = currentFolder?.pdfs || [];
  const items = tab === "pdfs" ? pdfs : videos;
  const total = currentFolder ? countTree(currentFolder) : { videos: 0, pdfs: 0 };

  const home = () => {
    setView("home"); setActiveBatch(null); setActiveSubject(null); setActiveChapter(null);
    setFolderStack([]); setPlayer(null); setQuery(""); setGroup("all");
  };
  const openBatch = async batch => {
    setActiveBatch(batch); setActiveSubject(null); setActiveChapter(null); setSubjects([]); setFolderStack([]);
    setPlayer(null); setTab("videos"); setView("folders"); setError(""); setResourcesLoading(true);
    try {
      const id = String(first(batch?.id, batch?.batch_id, batch?.course_id, batch?.batchId, ""));
      if (!id) throw new Error("Batch ID उपलब्ध नहीं है");
      let subjectRows = [];
      try {
        const subjectResponse = await apiGet("/api/disha/subjects?" + new URLSearchParams({ batchId: id }), 5000);
        subjectRows = apiRows(subjectResponse?.data ?? subjectResponse);
      } catch {}
      if (!subjectRows.length) subjectRows = await loadClassxSubjects(id);
      const loadedSubjects = subjectRows.map(subject => ({
        id: apiId(subject), title: apiTitle(subject), chapters: [], _chaptersLoaded: false
      })).filter(subject => subject.id);
      setSubjects(loadedSubjects);
      if (!loadedSubjects.length) setError("इस Batch के लिए API से कोई Subject नहीं मिला। Retry करें।");
    } catch (e) {
      setError("Subjects load नहीं हुए: " + e.message + " — Retry करें।");
    } finally { setResourcesLoading(false); }
  };
  const back = () => {
    if (player) { setPlayer(null); return; }
    if (folderStack.length > 1) { setFolderStack(stack => stack.slice(0, -1)); return; }
    if (activeChapter) { setActiveChapter(null); setFolderStack([]); return; }
    if (activeSubject) { setActiveSubject(null); return; }
    setActiveBatch(null); setSubjects([]); setView("home");
  };
  const openSubject = async subject => {
    setActiveSubject(subject); setActiveChapter(null); setFolderStack([]); setError("");
    setTab("videos");
    if (subject?._chaptersLoaded) return;
    setResourcesLoading(true);
    try {
      let chapterRows = [];
      try {
        const response = await apiGet("/api/disha/chapters?" + new URLSearchParams({ batchId, subjectId: subject.id }), 5000);
        chapterRows = apiRows(response?.data ?? response);
      } catch {}
      if (!chapterRows.length) chapterRows = await loadClassxChapters(batchId, subject.id);
      const chapters = chapterRows.map(chapter => ({
        id: apiId(chapter), title: apiTitle(chapter), folders: [], videos: [], pdfs: [], _loaded: false
      })).filter(chapter => chapter.id);
      const updated = { ...subject, chapters, _chaptersLoaded: true };
      setActiveSubject(updated);
      setSubjects(current => current.map(item => item.id === subject.id ? updated : item));
      if (!chapters.length) setError("इस Subject में chapters नहीं मिले।");
    } catch (error) {
      setError("Chapters load नहीं हुए: " + (error?.message || "API error"));
    } finally { setResourcesLoading(false); }
  };
  const openChapter = async chapter => {
    setActiveChapter(chapter); setFolderStack([chapter]); setTab("videos"); setError("");
    if (chapter?._loaded) return;
    setResourcesLoading(true);
    try {
      const tree = await loadFolderTree(batchId, activeSubject?.id || "", chapter.id);
      const loaded = { ...chapter, ...tree, _loaded: true };
      setActiveChapter(loaded);
      setFolderStack([loaded]);
    } catch (error) {
      setError("Study material load नहीं हुआ: " + (error?.message || "API error"));
    } finally { setResourcesLoading(false); }
  };
  const openFolder = async folder => {
    if (folder?._loaded) {
      setFolderStack(stack => [...stack, folder]);
      return;
    }
    setResourcesLoading(true);
    setError("");
    try {
      const tree = await loadFolderTree(batchId, activeSubject?.id || "", folder.id);
      setFolderStack(stack => [...stack, { ...folder, ...tree, _loaded: true }]);
    } catch (e) {
      setError("Folder का material load नहीं हुआ: " + (e?.message || "API error"));
      setFolderStack(stack => [...stack, folder]);
    } finally {
      setResourcesLoading(false);
    }
  };
  const openItem = async item => {
    if (isPdf(item)) {
      setPlayer({ kind: "pdf", item, url: "", downloadUrl: "", loading: true });
      try {
        let url = cleanUrl(item.pdfUrl || item.pdf_url || item.pdf_link || item.pdf_link2 || item.url || item.downloadUrl || item.download_url);
        if (!/^https?:\/\//i.test(url)) {
          const folderId = String(first(currentFolder?.id, activeChapter?.id, ""));
          if (!folderId || !item.title) throw new Error("PDF का folder ID या title उपलब्ध नहीं है");
          const params = new URLSearchParams({ folder: folderId, title: String(item.title) });
          const response = await fetch("https://tik-reels.vercel.app/api/pdf?" + params, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
            cache: "no-store"
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || data?.ok !== true || !/^https?:\/\//i.test(String(data?.url || ""))) {
            throw new Error(data?.message || "Original PDF provider से valid link नहीं मिला");
          }
          url = cleanUrl(data.url);
        }
        if (!/^https?:\/\//i.test(url)) throw new Error("PDF URL उपलब्ध नहीं है");
        setPlayer({ kind: "pdf", item, url, downloadUrl: cleanUrl(item.downloadUrl || item.download_url || url), loading: false });
      } catch (error) {
        setPlayer({ kind: "pdf", item, url: "", downloadUrl: "", loading: false, error: error?.message || "PDF load नहीं हुआ" });
      }
      return;
    }
    const asset = first(item?.asset, item?.asset_id, item?.assetId);
    let url = asset
      ? "https://targetboard.co.in/dashboard/video?v=" + encodeURIComponent(encodeAsset(asset))
      : cleanUrl(item.embedUrl || item.embed_url || item.playerUrl || item.player_url || item.streamUrl || item.stream_url || (item.videoId ? "https://www.youtube.com/embed/" + item.videoId + "?playsinline=1&rel=0" : ""));
    if (!url && item?.video_player_token && String(item.video_player_token) !== "1234") {
      url = "https://appx-play.classx.co.in/combined-img-player?isMobile=true&token=" + encodeURIComponent(String(item.video_player_token));
    }
    setPlayer({ kind: "video", item, url, downloadUrl: cleanUrl(item.downloadUrl || item.download_url || "") });
  };
  const downloadPdf = async () => {
    if (!player?.url) return;
    try {
      const response = await fetch(player.url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("PDF download HTTP " + response.status);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = (title(player.item) || "study-material") + ".pdf";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch {
      window.open(player.url, "_blank", "noopener,noreferrer");
    }
  };
  const subjectsCount = subjects.length;
  const headerTitle = activeChapter ? title(currentFolder) : activeSubject ? title(activeSubject) : activeBatch ? title(activeBatch) : view === "mine" ? "My Batches" : view === "developer" ? "Developer" : "All Batches";
  const headerSub = activeChapter ? "अपना learning material चुनें।" : activeSubject ? "Subject का chapter चुनें।" : activeBatch ? "Subject और study material खोलें।" : "अपने पसंदीदा batch में पढ़ाई शुरू करें।";

  return <div>
    <header className="topbar">
      {(activeBatch || player) && <button className="back-btn" onClick={back} aria-label="Back"><Icon name="back" /></button>}
      <a className="brand" href="#" onClick={event => { event.preventDefault(); home(); }}>
        <img src={BASE + "images/him-apps-logo.png"} alt="HIM APPS logo" />
        <span><b>HIM APPS</b><small>LEARN • GROW • SUCCEED</small></span>
      </a>
      <button className="profile-btn" onClick={() => setView("developer")} aria-label="Profile">●</button>
    </header>

    <main className="app-shell">
      {view === "developer" ? <section className="developer-panel">
        <img src={BASE + "images/him-apps-logo.png"} alt="HIM APPS" />
        <h2>HIM APPS</h2><p>Learning • Growth • Success</p>
        <div className="dev-credit">POWERED BY <b>HIMANSHU JII</b></div>
        <p className="dev-note">आपकी शिक्षा, आपकी सफलता — HIM APPS के साथ।</p>
      </section> : <section className="library">
        <div className="section-title">
          <div><h2>{headerTitle}</h2><p>{headerSub}</p></div>
          <span className="batch-count">{activeBatch ? (activeSubject ? (activeSubject.chapters || []).length + " CHAPTERS" : subjectsCount + " SUBJECTS") : view === "mine" ? "SAVED BATCHES" : batches.length + " BATCHES"}</span>
        </div>

        {!activeBatch && view !== "mine" && <label className="search"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search batches..." /></label>}
        {!activeBatch && view !== "mine" && <div className="filters">
          {["all","9th","10th","11th","12th","exam"].map(value => <button key={value} className={"filter " + (group === value ? "active" : "")} onClick={() => setGroup(value)}>{value === "all" ? "All Batches" : value === "exam" ? "Exams" : value + " Class"}</button>)}
        </div>}

        {activeBatch && <div className="breadcrumbs" onClick={back}>← {title(activeBatch)}{activeSubject ? " / " + title(activeSubject) : ""}{activeChapter ? " / " + title(currentFolder) : ""}</div>}

        {!activeBatch && view !== "mine" && <div className="course-grid">
          {loading && <div className="empty">Batches लोड हो रहे हैं…</div>}
          {!loading && error && <div className="empty">{error} <button onClick={load}>Retry</button></div>}
          {!loading && !error && visibleBatches.map((batch, index) => <article className="course-card" key={String(first(batch.id, batch._id, index))}>
            {imageOf(batch) ? <img className="batch-image" src={imageOf(batch)} alt={title(batch)} loading="lazy" onError={event => { event.currentTarget.src = BASE + "images/him-apps-logo.png"; }} /> : <img className="batch-image" src={BASE + "images/him-apps-logo.png"} alt="HIM APPS" />}
            <div className="card-info">
              <div className="card-meta"><span>{txt(first(batch.group, batch.class, batch.grade, batch.category), "HIM APPS")}</span><span className="group-tag">AVAILABLE</span></div>
              <h3>{title(batch)}</h3>
              <div className="card-meta"><span>{txt(first(batch.validity, batch.duration, ""), "Study material")}</span><span>HIM APPS</span></div>
              <div className="card-actions"><button className={"favourite-btn " + (favourites.includes(String(first(batch.id, batch.batch_id, batch.course_id, batch.batchId, ""))) ? "saved" : "")} onClick={() => toggleFavourite(batch)}>{favourites.includes(String(first(batch.id, batch.batch_id, batch.course_id, batch.batchId, ""))) ? "★ Saved" : "☆ Favourite"}</button></div>
              <div className="card-actions"><button className="enroll-btn" onClick={() => openBatch(batch)}>Open batch</button><button className="study-btn" onClick={() => openBatch(batch)}>Let's Study →</button></div>
            </div>
          </article>)}
          {!loading && !error && !visibleBatches.length && <div className="empty">कोई batch नहीं मिला।</div>}
        </div>}

        {view === "mine" && !activeBatch && <div className="course-grid">
          {savedBatches.map((batch, index) => <article className="course-card" key={String(first(batch.id, batch.batch_id, batch.course_id, index))}>
            {imageOf(batch) ? <img className="batch-image" src={imageOf(batch)} alt={title(batch)} loading="lazy" /> : <img className="batch-image" src={BASE + "images/him-apps-logo.png"} alt="HIM APPS" />}
            <div className="card-info"><div className="card-meta"><span>FAVOURITE</span><button className="favourite-btn saved" onClick={() => toggleFavourite(batch)}>★ Saved</button></div>
              <h3>{title(batch)}</h3><div className="card-actions"><button className="enroll-btn" onClick={() => openBatch(batch)}>Open batch</button><button className="study-btn" onClick={() => openBatch(batch)}>Let's Study →</button></div>
            </div>
          </article>)}
          {!savedBatches.length && <div className="empty">अभी कोई Favourite Batch नहीं है। All Batches में ☆ Favourite दबाकर यहाँ सेव करें।</div>}
        </div>}

        {activeBatch && !activeSubject && <div className="folder-list">
          {resourcesLoading && <div className="empty">Original API से Subjects लोड हो रहे हैं…</div>}
          {!resourcesLoading && subjects.map(subject => <button className="folder" key={subject.id} onClick={() => openSubject(subject)}>
            <span className="folder-icon"><Icon name="folder" /></span>
            <span><b>{title(subject)}</b><small>{(subject.chapters || []).length} chapters</small></span><span className="go">›</span>
          </button>)}
          {!resourcesLoading && !subjects.length && <div className="empty">{error || "इस batch के subjects API से नहीं मिले।"} <button onClick={() => openBatch(activeBatch)}>Retry</button></div>}
        </div>}

        {activeBatch && activeSubject && !activeChapter && <div className="folder-list">
          {(activeSubject.chapters || []).map(chapter => {
            const counts = countTree(chapter);
            return <button className="folder" key={chapter.id} onClick={() => openChapter(chapter)}>
              <span className="folder-icon"><Icon name="folder" /></span>
              <span><b>{title(chapter)}</b><small>{counts.videos} videos · {counts.pdfs} PDFs · {(chapter.folders || []).length} folders</small></span><span className="go">›</span>
            </button>;
          })}
          {!(activeSubject.chapters || []).length && <div className="empty">इस subject में chapters नहीं मिले।</div>}
        </div>}

        {activeBatch && activeChapter && <div className="material-panel">
          {(currentFolder?.folders || []).length > 0 && <div className="folder-list">
            {currentFolder.folders.map(folder => <button className="folder" key={folder.id} onClick={() => openFolder(folder)}>
              <span className="folder-icon"><Icon name="folder" /></span><span><b>{title(folder)}</b><small>{countTree(folder).videos} videos · {countTree(folder).pdfs} PDFs</small></span><span className="go">›</span>
            </button>)}
          </div>}
          <div className="tabs">
            <button className={"tab " + (tab === "videos" ? "active" : "")} onClick={() => setTab("videos")}>▶ Videos ({videos.length})</button>
            <button className={"tab " + (tab === "pdfs" ? "active" : "")} onClick={() => setTab("pdfs")}>▤ PDFs ({pdfs.length})</button>
          </div>
          <div>
            {items.map((item, index) => <button className="material-item" key={item.id || index} onClick={() => openItem(item)}>
              <span className="course-icon">{tab === "videos" ? <Icon name="video" /> : <Icon name="file" />}</span>
              <span><b>{title(item)}</b><small>{tab === "videos" ? (item.duration || "Video lecture") : "PDF study material"}</small></span>
              <span className="go">↗</span>
            </button>)}
            {!items.length && <div className="empty">{tab === "videos" ? "इस folder में video उपलब्ध नहीं है।" : "इस folder में PDF उपलब्ध नहीं है।"}</div>}
          </div>
        </div>}
      </section>}
    </main>

    <nav className="bottom-nav" aria-label="Main navigation">
      <button className={"nav-item " + (view === "home" ? "active" : "")} onClick={home}><Icon name="home" /><small>Home</small></button>
      <button className={"nav-item " + (view === "mine" ? "active" : "")} onClick={() => { setView("mine"); setActiveBatch(null); setActiveSubject(null); setActiveChapter(null); setFolderStack([]); }}><Icon name="mine" /><small>My Batches</small></button>
      <button className={"nav-item " + (view === "developer" ? "active" : "")} onClick={() => { setView("developer"); setActiveBatch(null); setActiveSubject(null); setActiveChapter(null); }}><Icon name="dev" /><small>Developer</small></button>
    </nav>

    {player && <div className="viewer-overlay open" onClick={event => { if (event.target === event.currentTarget) setPlayer(null); }}>
      <section className="viewer-dialog" role="dialog" aria-modal="true">
        <header className="viewer-header"><b className="viewer-title">{title(player.item)}</b><button className="viewer-close" onClick={() => setPlayer(null)} aria-label="Close">✕</button></header>
        {player.kind === "pdf" ? (player.loading ? <div className="empty">Original PDF link लोड हो रहा है…</div> : player.url ? <iframe className="viewer-frame" title="PDF viewer" src={player.url} /> : <div className="empty">{player.error || "इस PDF का valid URL API ने नहीं दिया।"}</div>) : player.url ? (/\.m3u8|\.mp4|\.webm/i.test(player.url) ? <video className="viewer-frame" controls playsInline src={player.url} /> : <iframe className="viewer-frame" title="Video player" src={player.url} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />) : <div className="empty">इस video का playback URL उपलब्ध नहीं है।</div>}
        {player.kind === "pdf" && player.url && <div className="viewer-header"><a href={player.url} target="_blank" rel="noreferrer">Open PDF ↗</a><button type="button" onClick={downloadPdf}>Download PDF ↓</button></div>}
        {player.kind === "video" && player.downloadUrl && <div className="viewer-header"><a href={player.downloadUrl} target="_blank" rel="noreferrer" download>Download original video ↓</a></div>}
      </section>
    </div>}
  </div>;
}
