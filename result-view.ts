import {WORKFLOW_LOGO, WORKFLOW_CSS} from "./workflow-brand.ts";
import {WORKFLOW_SCRIPT} from "./workflow-view.ts";
// One standard MCP Apps viewer for every completed governed Personal result.
// No credentials, public download URLs, external scripts, or durable storage.
export const RESULT_RESOURCE = {
  uri: "ui://neuralsynch/complete-result-v2.html",
  name: "NeuralSynch complete result",
  mimeType: "text/html;profile=mcp-app",
};
export function resultResourceContents() {
  return {
    ...RESULT_RESOURCE,
    text: RESULT_HTML,
    _meta: {
      ui: {
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [] },
      },
    },
  };
}
export const RESULT_HTML = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Complete NeuralSynch result</title>
<style>body{font:15px/1.55 system-ui,sans-serif;margin:0;padding:20px;color:#172c35;background:#fff}h1{font-size:20px;margin:0 0 8px}button{font:inherit;padding:8px 12px;border:1px solid #abc;border-radius:7px;background:#f1f7f7;margin:0 8px 12px 0;cursor:pointer}#status{white-space:pre-wrap;overflow-wrap:anywhere;color:#315e66}#result{max-height:520px;overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}section{padding:6px 0;border-bottom:1px solid #e3ebed}h2{font-size:16px}p{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:10px 0}summary{cursor:pointer}</style>
<h1>NeuralSynch complete result</h1><p id="status" role="status">Waiting for the original result…</p>
<style>${WORKFLOW_CSS}</style><section id="workflow" class="ns-workflow" hidden aria-label="NeuralSynch workflow"></section>
<button id="workflow-build" hidden>Build remaining Blueprint</button><button id="workflow-pause" hidden>Pause after this stage</button>
<button id="refresh" disabled>Recheck and recover</button><button id="download" disabled>Download complete JSON</button>
<button id="word" hidden>Download Word</button><button id="pdf" hidden>Download PDF</button><div id="result"></div>
<script>
const statusEl=document.getElementById('status'), resultEl=document.getElementById('result'), refresh=document.getElementById('refresh'), download=document.getElementById('download');
const WORKFLOW_LOGO=${JSON.stringify(WORKFLOW_LOGO)};
let seq=0, pending=new Map(), locator=null, busy=false, current=null, ready=false, hostCapabilities={};
function send(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('The host did not complete this read. Use Recheck and recover.'))},45000);pending.set(id,{resolve,reject,timer});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
async function downloadThroughHost(name,type,blob){
 if(!hostCapabilities.downloadFile)throw Error('This host does not support file downloads. The verified document remains saved; download is unavailable here. Sign in to your NeuralSynch Control Center, then open Workflows & documents. The desktop app is optional.');
 const result=await rpc('ui/download-file',{contents:[{type:'resource',resource:{uri:'file:///'+name,mimeType:type,blob}}]});
 if(!result||result.isError)throw Error('The host declined or could not complete the download. Your saved document is unchanged.');
 statusEl.textContent='Verified document sent to the host download handler. Check the host download prompt or downloads.';
}
function syncControls(){refresh.disabled=busy||workflowBusy||!locator;for(const id of ['word','pdf'])document.getElementById(id).disabled=busy||workflowBusy||(workflow&&workflow.snapshot.state!=='complete');buildButton.disabled=busy||workflowBusy||workflow?.snapshot.state==='blocked'}
function clear(message){current=null;resultEl.replaceChildren();download.disabled=true;statusEl.textContent=message}
function field(parent,key,value,depth=0){if(value===null||value===undefined)return;const section=document.createElement('section');const title=document.createElement('h2');title.textContent=key.replaceAll('_',' ');section.append(title);if(typeof value==='object'&&depth<8){for(const [k,v] of Object.entries(value))field(section,k,v,depth+1)}else{const p=document.createElement('p');p.textContent=typeof value==='string'?value:JSON.stringify(value);section.append(p)}parent.append(section)}
async function recover(){if(!ready||!locator||busy)return false;busy=true;syncControls();clear('Rechecking current access and loading the complete result…');try{
 const r=await rpc('tools/call',{name:'personal_result',arguments:locator});
 if(r.isError)throw new Error('Result withheld or unavailable under current source, authority, session or release settings.');
 const v=r._meta&&r._meta['neuralsynch/result'];if(!v||typeof v.payload!=='string')throw new Error('This host did not deliver the complete result to the viewer.');
 if(v.conversation_key!==locator.conversation_key||(locator.concept_id ? v.concept_id!==locator.concept_id||v.version!==locator.version : v.delivery.request_key!==locator.request_key))throw new Error('Result identity mismatch.');
 const bytes=new TextEncoder().encode(v.payload);const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==v.delivery.byte_length||digest!==v.delivery.sha256||!v.delivery.complete)throw new Error('Result integrity verification failed.');
 const parsed=JSON.parse(v.payload);current=v;
 statusEl.textContent=locator.concept_id?'Complete Blueprint verified. Review the concept below or download the editable Word document, PDF, or canonical JSON.':'Complete result verified in this interface. '+bytes.length+' UTF-8 bytes.\\nSHA-256: '+digest+'\\nRequest: '+v.delivery.request_key+'\\nRelease receipt: '+(v.automation?.final_receipt_id||'unavailable');
 const display=document.createElement('div');
 // SVG remains in an inert image context, never injected into the document.
 // Its exact original bytes are also retained in the complete JSON below.
 if(parsed.visual?.media_type==='image/svg+xml'&&typeof parsed.visual.svg==='string'){
 const svgBytes=new TextEncoder().encode(parsed.visual.svg);const svgHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',svgBytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(svgHash!==parsed.visual.sha256)throw new Error('Visual artifact integrity verification failed.');
 let binary='';for(const b of svgBytes)binary+=String.fromCharCode(b);const img=document.createElement('img');img.alt='Complete governed evidence visual';img.style.maxWidth='100%';img.src='data:image/svg+xml;base64,'+btoa(binary);display.append(img);
 }
 if(locator.concept_id&&Array.isArray(parsed.sections)){
 const title=document.createElement('h2');title.textContent=parsed.title;display.append(title);
 for(const section of parsed.sections){const el=document.createElement('section'),head=document.createElement('h2');head.textContent=section.heading;el.append(head);
 for(const b of section.blocks||[]){if(b.type==='table'){const wrap=document.createElement('div');wrap.style.overflowX='auto';const table=document.createElement('table');table.style.borderCollapse='collapse';for(const [i,row]of [b.columns,...b.rows].entries()){const tr=document.createElement('tr');for(const cell of row){const td=document.createElement(i===0?'th':'td');td.textContent=cell;td.style.cssText='border:1px solid #ccd;padding:8px;text-align:left;vertical-align:top';tr.append(td)}table.append(tr)}wrap.append(table);el.append(wrap)}else if(b.items){const list=document.createElement(b.type==='numbered'?'ol':'ul');for(const item of b.items){const li=document.createElement('li');li.textContent=item;list.append(li)}el.append(list)}else{const p=document.createElement('p');p.textContent=b.text||'';el.append(p)}}display.append(el)}
 field(display,'Sources',parsed.sources);
 }else for(const [k,value]of Object.entries(parsed))field(display,k,value);resultEl.append(display);
 const details=document.createElement('details'),summary=document.createElement('summary'),raw=document.createElement('pre');summary.textContent='Exact complete JSON';raw.id='complete-json';raw.textContent=v.payload;details.append(summary,raw);resultEl.append(details);download.disabled=false;return true;
 }catch(e){clear(e.message);return false}finally{busy=false;syncControls();send('ui/notifications/size-changed',{height:Math.min(document.documentElement.scrollHeight,760)})}}
${WORKFLOW_SCRIPT}
refresh.onclick=()=>workflow?recoverWorkflow():recover();
for(const [id,format,type]of [['word','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['pdf','pdf','application/pdf']])document.getElementById(id).onclick=async()=>{
 if(!locator?.concept_id||busy||workflowBusy)return;busy=true;syncControls();clear('Rechecking access and retrieving the original document…');try{
 const r=await rpc('tools/call',{name:'personal_result',arguments:{...locator,format}}),v=r._meta?.['neuralsynch/result'];
 if(r.isError||!v||v.concept_id!==locator.concept_id||v.version!==locator.version||v.conversation_key!==locator.conversation_key||v.format!==format||v.encoding!=='base64'||v.media_type!==type||!v.delivery?.complete)throw Error('Document withheld or identity mismatch.');
 const bytes=Uint8Array.from(atob(v.payload),c=>c.charCodeAt(0)),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==v.delivery.byte_length||hash!==v.delivery.sha256)throw Error('Document integrity verification failed.');
 await downloadThroughHost('concept-blueprint-v'+locator.version+'.'+format,type,v.payload);
 }catch(e){clear(e.message)}finally{busy=false;syncControls()}
};
download.onclick=async()=>{if(!await recover())return;busy=true;syncControls();try{let binary='';for(const b of new TextEncoder().encode(current.payload))binary+=String.fromCharCode(b);await downloadThroughHost('neuralsynch-'+current.delivery.id+'.json','application/json',btoa(binary))}catch(e){statusEl.textContent=e.message}finally{busy=false;syncControls()}};
addEventListener('message',event=>{if(event.source!==parent)return;const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
 if(m.method==='ui/notifications/tool-result'&&!locator&&m.params?.structuredContent?.schema==='neuralsynch.workflow.v1'){
 const v=m.params.structuredContent;locator={conversation_key:v.conversation_key,concept_id:v.concept_id,version:v.version};workflow=v;refresh.disabled=false;document.getElementById('word').hidden=false;document.getElementById('pdf').hidden=false;if(ready)recoverWorkflow();return;}
 if(m.method==='ui/notifications/tool-result'&&!locator){const v=m.params?.structuredContent;if(v?.conversation_key&&v.delivery?.request_key){locator=v.concept_id?{conversation_key:v.conversation_key,concept_id:v.concept_id,version:v.version}:{conversation_key:v.conversation_key,request_key:v.delivery.request_key};document.getElementById('word').hidden=!v.concept_id;document.getElementById('pdf').hidden=!v.concept_id;refresh.disabled=false;recover()}else if(m.params?.isError)clear('Result withheld or unavailable.');}
 if(m.method==='ui/resource-teardown'){workflowClosed=true;workflowStop=true;clear('Closed');parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*')}
});
rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'NeuralSynch complete result',version:'1.0.2'},appCapabilities:{availableDisplayModes:['inline']}}).then(result=>{hostCapabilities=result.hostCapabilities||{};ready=true;send('ui/notifications/initialized',{});workflow?recoverWorkflow():recover()}).catch(e=>clear(e.message));
</script></html>`;
