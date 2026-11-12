import React, { useEffect, useMemo, useState } from "react";

const API_URL = "https://hrrydoc.vercel.app/api/disha/batches";
const TELEGRAM_URL = "https://t.me/HIMAPPS";

const first = (...values) => values.find(v => v !== undefined && v !== null && v !== "");
const text = (v, fallback = "") => typeof v === "string" || typeof v === "number" ? String(v) : fallback;
const getTitle = x => text(first(x?.title, x?.name, x?.batchName, x?.batch_name, x?.label), "Untitled");
const getImage = x => first(x?.banner, x?.bannerUrl, x?.banner_url, x?.image, x?.imageUrl, x?.image_url, x?.thumbnail, x?.thumbnailUrl, x?.cover);
const getUrl = x => first(x?.url, x?.link, x?.fileUrl, x?.file_url, x?.pdfUrl, x?.pdf_url, x?.videoUrl, x?.video_url, x?.src, x?.downloadUrl);
const isPdf = x => /pdf/i.test([x?.type, x?.kind, x?.mimeType, x?.mime_type, x?.format, getUrl(x)].filter(Boolean).join(" "));
const isVideo = x => /video|mp4|m3u8|webm/i.test([x?.type, x?.kind, x?.mimeType, x?.mime_type, x?.format, getUrl(x)].filter(Boolean).join(" "));
const isMedia = x => isPdf(x) || isVideo(x) || Boolean(getUrl(x));
const listFrom = data => {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["batches", "data", "results", "items", "courses", "payload"]) {
    const value = data[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = listFrom(value);
      if (nested.length) return nested;
    }
  }
  return [];
};
const collectContent = batch => {
  const out = [];
  const seen = new Set();
  const walk = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) { value.forEach(v => walk(v, depth + 1)); return; }
    if (typeof value !== "object") return;
    if (isMedia(value)) {
      const url = getUrl(value);
      if (url && !seen.has(url)) { seen.add(url); out.push(value); }
    }
    for (const key of ["chapters", "sections", "modules", "lessons", "contents", "content", "videos", "pdfs", "resources", "topics", "subjects", "items", "files"]) {
      if (value[key]) walk(value[key], depth + 1);
    }
  };
  walk(batch);
  return out;
};
const Icon = ({ name, size = 20 }) => {
  const paths = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 5.5v13A2.5 2.5 0 0 1 6.5 16H20"/></>,
    play: <path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"/><path d="m9 12 2 2 4-4"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.book}</svg>;
};

function App() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeBatch, setActiveBatch] = useState(null);
  const [filter, setFilter] = useState("all");
  const [player, setPlayer] = useState(null);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);

  const loadBatches = async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(API_URL, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("Server returned " + response.status);
      const json = await response.json();
      const rows = listFrom(json);
      if (!rows.length && json && (json.success === false || json.error)) throw new Error(text(json.message || json.error, "API request failed"));
      setBatches(rows);
    } catch (e) {
      setError("Batches abhi load nahi ho paaye. Internet check karke dobara try karein.");
    } finally { setLoading(false); }
  };

  useEffect(() => { loadBatches(); }, []);
  useEffect(() => {
    if (sessionStorage.getItem("himdisha-telegram-dismissed")) return;
    const timer = window.setTimeout(() => setTelegramOpen(true), 9000);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleBatches = useMemo(() => batches.filter(b => getTitle(b).toLowerCase().includes(query.toLowerCase())), [batches, query]);
  const content = useMemo(() => activeBatch ? collectContent(activeBatch) : [], [activeBatch]);
  const filteredContent = content.filter(item => filter === "all" || (filter === "pdf" ? isPdf(item) : isVideo(item)));
  const closeTelegram = () => { setTelegramOpen(false); sessionStorage.setItem("himdisha-telegram-dismissed", "1"); };
  const openItem = item => setPlayer({ item, kind: isPdf(item) ? "pdf" : isVideo(item) ? "video" : "link" });

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setActiveBatch(null); }}>
        <img src="/him-disha.svg" alt="HIM DISHA" /><span>HIM <b>DISHA</b><small>LEARN · GROW · ACHIEVE</small></span>
      </a>
      <nav className={mobileMenu ? "nav-links show" : "nav-links"}>
        <button onClick={() => { setActiveBatch(null); setMobileMenu(false); }}>Home</button>
        <a href="#batches" onClick={() => setMobileMenu(false)}>Explore batches</a>
        <a href={TELEGRAM_URL} target="_blank" rel="noreferrer">Telegram <Icon name="arrow" size={14}/></a>
      </nav>
      <button className="menu-btn" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle menu"><Icon name="menu"/></button>
      <a className="top-cta" href={TELEGRAM_URL} target="_blank" rel="noreferrer">Join community <Icon name="arrow" size={16}/></a>
    </header>

    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot"/> YOUR LEARNING COMPANION</div>
          <h1>Find your direction.<br/><em>Own your future.</em></h1>
          <p>One place for your batches, classes and study material. Learn at your pace, move forward with confidence.</p>
          <div className="hero-actions"><a href="#batches" className="primary-btn">Explore batches <Icon name="arrow" size={17}/></a><span className="secure-note"><Icon name="shield" size={16}/> A smarter way to learn</span></div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
          <div className="hero-logo"><img src="/him-disha.svg" alt=""/></div>
          <div className="float-card float-top"><span className="float-icon"><Icon name="book"/></span><span><b>Learn daily</b><small>Small steps, big goals</small></span></div>
          <div className="float-card float-bottom"><span className="float-icon aqua"><Icon name="play"/></span><span><b>Learn anywhere</b><small>Video · PDF · Notes</small></span></div>
          <div className="spark spark-a">✦</div><div className="spark spark-b">✧</div>
        </div>
      </section>

      <section className="stats-strip">
        <div><b>01</b><span>Choose your batch</span></div><i/><div><b>02</b><span>Open your lessons</span></div><i/><div><b>03</b><span>Keep progressing</span></div>
      </section>

      <section className="batch-section" id="batches">
        <div className="section-heading"><div><div className="eyebrow dark-eyebrow">YOUR CLASSROOM</div><h2>{activeBatch ? getTitle(activeBatch) : "Explore your batches"}</h2><p>{activeBatch ? "Choose a lesson and continue learning." : "Everything you need, organized in one place."}</p></div>
          {activeBatch ? <button className="back-btn" onClick={() => { setActiveBatch(null); setFilter("all"); }}>← All batches</button> : <div className="search-box"><Icon name="search" size={18}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search batches..." aria-label="Search batches"/></div>}
        </div>

        {!activeBatch && <div className="batch-grid">
          {loading && <div className="state-card"><div className="loader"/><b>Loading your classroom</b><span>Fetching the latest batches…</span></div>}
          {!loading && error && <div className="state-card error-state"><b>Unable to load batches</b><span>{error}</span><button className="primary-btn small-btn" onClick={loadBatches}>Try again</button></div>}
          {!loading && !error && visibleBatches.length === 0 && <div className="state-card"><b>{batches.length ? "No matching batches" : "Batches coming soon"}</b><span>{batches.length ? "Try another search term." : "New learning batches will appear here."}</span></div>}
          {!loading && !error && visibleBatches.map((batch, index) => <button className="batch-card" key={text(first(batch.id, batch._id, batch.slug), index)} onClick={() => setActiveBatch(batch)}>
            <div className="batch-banner">{getImage(batch) ? <img src={getImage(batch)} alt={getTitle(batch)} loading="lazy" onError={e => { e.currentTarget.style.display = "none"; }}/> : <div className="banner-fallback"><img src="/him-disha.svg" alt=""/><span>HIM DISHA</span></div>}<span className="batch-number">BATCH {String(index + 1).padStart(2, "0")}</span></div>
            <div className="batch-info"><div><h3>{getTitle(batch)}</h3><p>{text(first(batch.description, batch.subtitle, batch.category), "Study material and lessons")}</p></div><span className="card-arrow"><Icon name="arrow" size={18}/></span></div>
          </button>)}
        </div>}

        {activeBatch && <div className="lesson-area">
          <div className="lesson-toolbar"><div className="lesson-count"><Icon name="layers" size={17}/>{content.length} learning resources</div><div className="filter-tabs">{[["all","All"],["video","Videos"],["pdf","PDFs"]].map(([key,label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div></div>
          {filteredContent.length === 0 ? <div className="state-card"><b>No lessons found</b><span>This batch has no matching video or PDF resources in the API response.</span></div> : <div className="lesson-grid">{filteredContent.map((item, i) => <article className="lesson-card" key={text(first(item.id, item._id, getUrl(item)), i)}><div className={isPdf(item) ? "lesson-icon pdf-icon" : "lesson-icon video-icon"}><Icon name={isPdf(item) ? "file" : "play"} size={22}/></div><div className="lesson-copy"><b>{getTitle(item) === "Untitled" ? text(first(item.name, item.title, item.fileName, item.filename), isPdf(item) ? "Study PDF" : "Video lesson") : getTitle(item)}</b><span>{isPdf(item) ? "PDF DOCUMENT" : isVideo(item) ? "VIDEO LESSON" : "LEARNING RESOURCE"}</span></div><button className="open-lesson" onClick={() => openItem(item)}>{isPdf(item) ? "Open PDF" : "Play"} <Icon name="arrow" size={15}/></button></article>)}</div>}
        </div>}
      </section>
    </main>

    <footer><a className="brand footer-brand" href="#"><img src="/him-disha.svg" alt=""/><span>HIM <b>DISHA</b><small>LEARN · GROW · ACHIEVE</small></span></a><span>Made for learners, built for possibilities.</span><a href={TELEGRAM_URL} target="_blank" rel="noreferrer">Join Telegram ↗</a></footer>

    {player && <div className="modal-backdrop" role="presentation" onClick={() => setPlayer(null)}><section className="viewer-modal" role="dialog" aria-modal="true" aria-label="Learning material" onClick={e => e.stopPropagation()}><div className="viewer-head"><div><span className="eyebrow dark-eyebrow">HIM DISHA CLASSROOM</span><h3>{getTitle(player.item)}</h3></div><button className="icon-btn" onClick={() => setPlayer(null)} aria-label="Close"><Icon name="close"/></button></div>
      {player.kind === "video" ? <video className="video-player" src={getUrl(player.item)} controls playsInline autoPlay preload="metadata">Your browser does not support video playback.</video> : player.kind === "pdf" ? <iframe className="pdf-viewer" title="PDF viewer" src={getUrl(player.item)} /> : <div className="external-resource"><p>This resource will open in a new tab.</p><a className="primary-btn" href={getUrl(player.item)} target="_blank" rel="noreferrer">Open resource <Icon name="arrow"/></a></div>}
      <div className="viewer-foot">{player.kind === "pdf" && <a className="download-btn" href={getUrl(player.item)} download><Icon name="download" size={17}/> Download PDF</a>}<a className="open-new" href={getUrl(player.item)} target="_blank" rel="noreferrer">Open in new tab ↗</a></div>
    </section></div>}

    {telegramOpen && <div className="telegram-overlay"><div className="telegram-card"><button className="telegram-close" onClick={closeTelegram} aria-label="Close"><Icon name="close" size={18}/></button><div className="telegram-mark">➤</div><div className="eyebrow dark-eyebrow">STAY IN THE LOOP</div><h3>Join the HIM DISHA community</h3><p>Get learning updates, announcements and new batch information.</p><a className="primary-btn telegram-join" href={TELEGRAM_URL} target="_blank" rel="noreferrer" onClick={closeTelegram}>Join on Telegram <Icon name="arrow" size={17}/></a><button className="later-btn" onClick={closeTelegram}>Maybe later</button></div></div>}
  </div>;
}

export default App;