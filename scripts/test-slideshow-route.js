import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function streamShortcutSlideshow('),source.indexOf('\nfunction itemQualityScore'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'onepick-route-test-'));
async function trial({failMkdir=false,mode='ok',limit=100}={}) {
 let stops=0,fetches=0,renders=0;
 const fakefs={...fs,mkdtempSync:()=>{if(failMkdir)throw Error('disk failure');return fs.mkdtempSync(path.join(root,'job-'));}};
 const context={AbortController,Readable,Transform,pipeline,fs:fakefs,path,os,Date,
 runLimitedMp4Normalization:fn=>fn(),createUpstreamDeadline:()=>()=>stops++,
 candidateUrlsForItem:item=>item.urls,maxRemoteDownloadBytes:limit,
 assertPublicUrl:async url=>{if(mode==='private')throw Error('private rejected');},enforceDownloadCookieRequirement:()=> 'douyin',mediaRequestHeaders:()=>({}),
 fetchPublicUrl:async()=>{fetches++;if(mode==='network'&&fetches===1)throw Error('connection reset');if(mode==='broken'&&fetches===1)return {ok:true,body:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.error(Error('broken'));}})};return new Response(new Uint8Array(mode==='size'?101:3));},
 assertContentLength:()=>{},renderSlideshow:async ({tempDir})=>{renders++;const f=path.join(tempDir,'out');fs.writeFileSync(f,'ok');return {path:f,duration:1,creationTime:'test'};},
 safeDownloadName:x=>x,contentDisposition:x=>x,pipeLocalFileToResponse:async()=>{},appendHistory:()=>{}};
 vm.createContext(context);vm.runInContext(code+'\nthis.run=streamShortcutSlideshow;',context);
 let error;try{await context.run({slideshow:{images:[{urls:['https://a','https://b']}],audio:{urls:['https://c']}},parsed:{title:'test'},req:{},res:{setHeader(){}},started:Date.now()});}catch(e){error=e;}
 assert.equal(stops,1,'deadline cleaned on every exit');assert.equal(fs.readdirSync(root).length,0,'all task directories cleaned');
 return {error,fetches,renders};
}
try{
 assert.match((await trial({failMkdir:true})).error.message,/disk failure/);
 for(const mode of ['network','broken']){const r=await trial({mode});assert.equal(r.error,undefined);assert.equal(r.fetches,3);assert.equal(r.renders,1);}
 const denied=await trial({mode:'private'});assert.match(denied.error.message,/private/);assert.equal(denied.fetches,0);
 const large=await trial({mode:'size'});assert.match(large.error.message,/大小限制/);assert.equal(large.fetches,1);assert.equal(large.renders,0);
 assert.equal((await trial()).error,undefined);
 console.log('Slideshow actual handler: cleanup, network/body fallback, private rejection, size limit passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
