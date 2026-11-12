import { readFile, writeFile } from "node:fs/promises";
const API = "https://hrrydoc.vercel.app";
const wait = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  let error;
  for (let n=1;n<=4;n++) {
    try {
      const r=await fetch(API+path,{headers:{Accept:"application/json"},cache:"no-store"});
      const raw=await r.text(); const j=JSON.parse(raw);
      if(!r.ok || j?.success===false) throw new Error(j?.message||j?.error||("HTTP "+r.status));
      return j;
    } catch(e) { error=e; if(n<4) await wait(n*650); }
  }
  throw error;
}
const arr=x=>Array.isArray(x)?x:Array.isArray(x?.data)?x.data:[];
const id=x=>String(x?.id??x?.folder_id??x?.chapter_id??x?.subject_id??"");
const title=x=>String(x?.title??x?.name??x?.Title??x?.subject_name??"Untitled");
async function parallel(xs,fn,limit=3){
  let i=0; const out=new Array(xs.length);
  await Promise.all(Array.from({length:Math.min(limit,xs.length)},async()=>{
    while(i<xs.length){const n=i++;try{out[n]=await fn(xs[n]);}catch(e){out[n]={_error:e.message};}await wait(100);}
  }));
  return out.filter(x=>x&&!x._error);
}
function resource(x,kind){return {
 id:String(x?.id??x?.lecture_id??x?.file_id??""),title:title(x),duration:String(x?.duration??""),
 thumbnail:String(x?.thumbnail??""),kind,
 streamUrl:String(x?.streamUrl??x?.stream_url??""),embedUrl:String(x?.embedUrl??x?.embed_url??""),
 videoId:String(x?.videoId??x?.video_id??""),qualities:Array.isArray(x?.qualities)?x.qualities:[],
 pdfUrl:String(x?.pdfUrl??x?.pdf_url??x?.pdf_link??x?.file_link??""),pdfKey:String(x?.pdfKey??x?.pdf_key??"")
};}
async function folder(batchId,subjectId,chapterId,seen,depth=0){
 const key=batchId+":"+chapterId;
 if(seen.has(key)||depth>9||seen.size>1200)return {id:chapterId,folders:[],videos:[],pdfs:[]};
 seen.add(key);
 const q=new URLSearchParams({batchId,subjectId,chapterId});
 const j=await get("/api/disha/lectures?"+q);
 const videos=Array.isArray(j.lectures)?j.lectures:arr(j.data?.lectures);
 const pdfs=Array.isArray(j.pdfs)?j.pdfs:arr(j.data?.pdfs);
 const children=Array.isArray(j.subFolders)?j.subFolders:arr(j.data?.subFolders);
 const folders=await parallel(children,async f=>{
  const fid=id(f); if(!fid)return null;
  return {id:fid,title:title(f),...(await folder(batchId,subjectId,fid,seen,depth+1))};
 });
 return {id:chapterId,folders,videos:videos.map(x=>resource(x,"video")).filter(x=>x.id),pdfs:pdfs.map(x=>resource(x,"pdf")).filter(x=>x.id||x.pdfUrl)};
}
async function build(batch){
 const batchId=String(batch.id??batch.batch_id??batch.course_id??"");
 const subjects=await parallel(arr(await get("/api/disha/subjects?"+new URLSearchParams({batchId}))),async s=>{
  const subjectId=id(s); if(!subjectId)return null;
  const chapters=await parallel(arr(await get("/api/disha/chapters?"+new URLSearchParams({batchId,subjectId}))),async c=>{
   const chapterId=id(c); if(!chapterId)return null;
   return {id:chapterId,title:title(c),...(await folder(batchId,subjectId,chapterId,new Set()))};
  });
  return {id:subjectId,title:title(s),chapters};
 });
 return {subjects};
}
const source=JSON.parse(await readFile("public/disha-batches.json","utf8"));
const batches=arr(source), result={success:true,generatedAt:new Date().toISOString(),batches:{},errors:{}};
for(const b of batches){
 const id=String(b.id??b.batch_id??b.course_id??""); if(!id)continue;
 try { console.log("Fetching Disha content",id); result.batches[id]=await build(b); console.log("Subjects",id,result.batches[id].subjects.length); }
 catch(e){result.batches[id]={subjects:[]};result.errors[id]=e.message;console.warn("Batch content failed",id,e.message);}
 await wait(300);
}
await writeFile("public/disha-content.json",JSON.stringify(result));
console.log("Disha content snapshot complete",Object.keys(result.batches).length,"batches");
