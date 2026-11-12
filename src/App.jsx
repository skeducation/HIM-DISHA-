import React, { useEffect, useMemo, useState } from "react";

const BASE = import.meta.env.BASE_URL;
const API_URL = "https://hrrydoc.vercel.app/api/disha/batches";
const TELEGRAM_URL = "https://t.me/HIMAPPS";
const DishaAPI = "https://hrrydoc.vercel.app";
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
async function apiGet(path) {
  const response = await fetch(DishaAPI + path, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("API HTTP " + response.status);
  const json = await response.json();
  if (json?.success === false) throw new Error(json.error || json.message || "API error");
  return json;
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
  return s.match(/(?:v=|youtu\\.be\\/|embed\\/|live\\/|shorts\\/)([A-Za-z0-9_-]{11})/)?.[1] || "";
};
async function normalizeApiResource(item, kind) {
  const links = Array.isArray(item?.encrypted_links) ? item.encrypted_links : [];
  const qualities = [];
  let streamUrl = "", downloadUrl = "", videoId = "";
  for (const link of links) {
    const url = await decodeAppx(link.path) || await decodeAppx(link.backup_url);
    if (/^https?:\\/\\//i.test(url) && !/\\/hls-drm-/i.test(url)) {
      qualities.push({ quality: String(link.quality || "Auto"), url }); streamUrl ||= url;
    }
  }
  for (const key of ["download_link","download_link2","download_url_higher_version","download_url_lower_version","recording_hls","file_link"]) {
    const url = await decodeAppx(item?.[key]); if (!url) continue;
    const id = ytId(url); if (id) videoId ||= id;
    else if (/^https?:\\/\\//i.test(url) && !/\\/hls-drm-/i.test(url)) {
      if (key === "download_link" && !/\\.m3u8(?:$|\\?)/i.test(url)) downloadUrl ||= url;
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
  const q = new URLSearchParams({ batchId, subjectId, chapterId });
  const response = await apiGet("/api/disha/lectures?" + q);
  const data = response?.data && typeof response.data === "object" ? response.data : response;
  const videosRaw = Array.isArray(response?.lectures) ? response.lectures : apiRows(data?.lectures);
  const pdfsRaw = Array.isArray(response?.pdfs) ? response.pdfs : apiRows(data?.pdfs);
  const children = Array.isArray(response?.subFolders) ? response.subFolders : apiRows(data?.subFolders);
  const folders = await Promise.all(children.map(async child => ({ id: apiId(child), title: apiTitle(child), ...await loadFolderTree(batchId, subjectId, apiId(child), depth + 1, seen) })));
  const videos = await Promise.all(videosRaw.map(item => normalizeApiResource(item, "video")));
  const pdfs = await Promise.all(pdfsRaw.map(item => normalizeApiResource(item, "pdf")));
  return { id: chapterId, folders, videos: videos.filter(x => x.id), pdfs: pdfs.filter(x => x.id || x.pdfUrl) };
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
  const [contentData, setContentData] = useState(null);
  const [contentReady, setContentReady] = useState(false);
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

  const load = async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(BASE + "disha-batches.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Batch snapshot HTTP " + response.status);
      const json = await response.json();
      const rows = listFrom(json?.data ?? json);
      if (!rows.length) throw new Error("Batches API returned an empty list");
      setBatches(rows);
    } catch (snapshotError) {
      try {
        const response = await fetch(API_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const json = await response.json();
        const rows = listFrom(json?.data ?? json);
        if (!rows.length) throw new Error("Empty batch list");
        setBatches(rows);
      } catch (liveError) {
        setError("Batches load नहीं हुए: " + (liveError?.message || snapshotError.message));
      }
    } finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    fetch(BASE + "disha-content.json", { cache: "no-store" })
      .then(response => { if (!response.ok) throw new Error("Content snapshot HTTP " + response.status); return response.json(); })
      .then(setContentData)
      .catch(error => console.warn("Resources snapshot:", error.message))
      .finally(() => setContentReady(true));
  }, []);

  const visibleBatches = useMemo(() => batches.filter(batch => {
    const matchesText = title(batch).toLowerCase().includes(query.toLowerCase());
    const groupText = String(first(batch?.group, batch?.class, batch?.grade, batch?.category, "")).toLowerCase();
    const matchesGroup = group === "all" || groupText.includes(group);
    return matchesText && matchesGroup;
  }), [batches, query, group]);

  const batchId = activeBatch ? String(first(activeBatch.id, activeBatch.batch_id, activeBatch.course_id, activeBatch.batchId, "")) : "";
  const subjects = contentData?.batches?.[batchId]?.subjects || [];
  const currentFolder = folderStack.length ? folderStack[folderStack.length - 1] : activeChapter;
  const videos = currentFolder?.videos || [];
  const pdfs = currentFolder?.pdfs || [];
  const items = tab === "pdfs" ? pdfs : videos;
  const total = currentFolder ? countTree(currentFolder) : { videos: 0, pdfs: 0 };

  const home = () => {
    setView("home"); setActiveBatch(null); setActiveSubject(null); setActiveChapter(null);
    setFolderStack([]); setPlayer(null); setQuery(""); setGroup("all");
  };
  const openBatch = batch => {
    setActiveBatch(batch); setActiveSubject(null); setActiveChapter(null); setFolderStack([]);
    setPlayer(null); setTab("videos"); setView("folders");
  };
  const back = () => {
    if (player) { setPlayer(null); return; }
    if (folderStack.length > 1) { setFolderStack(stack => stack.slice(0, -1)); return; }
    if (activeChapter) { setActiveChapter(null); setFolderStack([]); return; }
    if (activeSubject) { setActiveSubject(null); return; }
    setActiveBatch(null); setView("home");
  };
  const openChapter = async chapter => {
    setActiveChapter({ ...chapter, folders: [], videos: [], pdfs: [] }); setFolderStack([]); setTab("videos"); setResourcesLoading(true);
    try {
      const batch = String(first(activeBatch?.id, activeBatch?.batch_id, activeBatch?.course_id, activeBatch?.batchId, ""));
      const subject = String(first(activeSubject?.id, activeSubject?.subject_id, ""));
      const q = new URLSearchParams({ batchId: batch, subjectId: subject });
      const response = await apiGet("/api/disha/chapters?" + q);
      const chapterRows = apiRows(response?.data ?? response);
      const actual = chapterRows.find(x => apiId(x) === apiId(chapter)) || chapter;
      const tree = await loadFolderTree(batch, subject, apiId(chapter));
      const full = { ...actual, ...tree, id: apiId(chapter), title: apiTitle(chapter) };
      setActiveChapter(full); setFolderStack([full]);
    } catch (e) { setActiveChapter({ ...chapter, folders: [], videos: [], pdfs: [], loadError: e.message }); setFolderStack([]); }
    finally { setResourcesLoading(false); }
  };
  const openFolder = folder => setFolderStack(stack => [...stack, folder]);
  const openItem = item => {
    if (isPdf(item)) {
      const url = cleanUrl(item.pdfUrl || item.pdf_url || item.url);
      setPlayer({ kind: "pdf", item, url, downloadUrl: cleanUrl(item.downloadUrl || item.download_url || url) });
    } else {
      setPlayer({ kind: "video", item, url: cleanUrl(item.embedUrl || item.embed_url || item.streamUrl || item.stream_url || (item.videoId ? "https://www.youtube.com/embed/" + item.videoId : "")), downloadUrl: cleanUrl(item.downloadUrl || item.download_url || "") });
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
              <div className="card-actions"><button className="enroll-btn" onClick={() => openBatch(batch)}>Open batch</button><button className="study-btn" onClick={() => openBatch(batch)}>Let's Study →</button></div>
            </div>
          </article>)}
          {!loading && !error && !visibleBatches.length && <div className="empty">कोई batch नहीं मिला।</div>}
        </div>}

        {view === "mine" && !activeBatch && <div className="empty">My Batches देखने के लिए किसी batch को खोलें।</div>}

        {activeBatch && !activeSubject && <div className="folder-list">
          {!contentReady && <div className="empty">Resources लोड हो रहे हैं…</div>}
          {contentReady && subjects.map(subject => <button className="folder" key={subject.id} onClick={() => setActiveSubject(subject)}>
            <span className="folder-icon"><Icon name="folder" /></span>
            <span><b>{title(subject)}</b><small>{(subject.chapters || []).length} chapters</small></span><span className="go">›</span>
          </button>)}
          {!resourcesLoading && !subjects.length && <div className="empty">{error || "इस batch के subjects API से नहीं मिले। Refresh करके दोबारा कोशिश करें।"}</div>}
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
        {player.kind === "pdf" ? (player.url ? <iframe className="viewer-frame" title="PDF viewer" src={player.url} /> : <div className="empty">इस PDF का valid URL API ने नहीं दिया।</div>) : player.url ? (/\.m3u8|\.mp4|\.webm/i.test(player.url) ? <video className="viewer-frame" controls playsInline src={player.url} /> : <iframe className="viewer-frame" title="Video player" src={player.url} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />) : <div className="empty">इस video का playback URL उपलब्ध नहीं है।</div>}
        {player.kind === "pdf" && player.url && <div className="viewer-header"><a href={player.url} target="_blank" rel="noreferrer">Open PDF ↗</a><a href={player.downloadUrl || player.url} target="_blank" rel="noreferrer" download>Download PDF ↓</a></div>}
        {player.kind === "video" && player.downloadUrl && <div className="viewer-header"><a href={player.downloadUrl} target="_blank" rel="noreferrer" download>Download original video ↓</a></div>}
      </section>
    </div>}
  </div>;
}
