import {assertEquals,assertRejects} from 'jsr:@std/assert@^1.0.0';
import {RESULT_HTML} from '../result-view.ts';
const source=RESULT_HTML.slice(RESULT_HTML.indexOf('async function downloadThroughHost'),RESULT_HTML.indexOf('function syncControls'));
function fixture(capabilities:object,result:unknown={}){
 const calls:unknown[]=[];const status={textContent:''};
 const download=new Function('rpc','hostCapabilities','statusEl',source+';return downloadThroughHost;')(async(method:string,params:unknown)=>{calls.push({method,params});return result;},capabilities,status);
 return {calls,status,download};
}
Deno.test('sandbox download uses host RPC with exact verified bytes, no network URL or blob click',async()=>{
 const f=fixture({downloadFile:{}});await f.download('concept.docx','application/docx','AAH/');
 assertEquals(f.calls,[{method:'ui/download-file',params:{contents:[{type:'resource',resource:{uri:'file:///concept.docx',mimeType:'application/docx',blob:'AAH/'}}]}}]);
 assertEquals(f.status.textContent.includes('downloaded'),false);
 assertEquals(RESULT_HTML.includes('URL.createObjectURL'),false);
});
Deno.test('unsupported host and cancelled download never claim delivery',async()=>{
 const absent=fixture({});await assertRejects(()=>absent.download('x.pdf','application/pdf','AA=='),Error,'does not support');assertEquals(absent.calls,[]);
 const denied=fixture({downloadFile:{}},{isError:true});await assertRejects(()=>denied.download('x.pdf','application/pdf','AA=='),Error,'declined');assertEquals(denied.status.textContent,'');
});
