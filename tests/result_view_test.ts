import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { callPersonalResult } from "../personal-result.ts";
import { bindToolArguments } from "../auth.ts";
import { MCPServer } from "../mcp-protocol.ts";
import { RESULT_RESOURCE } from "../result-view.ts";
const key="33333333-3333-4333-8333-333333333333";
const principal={userId:'u',accessToken:'test-oauth',tenantRoles:new Map<string,string>()};
const args=()=>bindToolArguments('personal_result',{conversation_key:key,request_key:'session:1'},principal);
async function fixture(mode='ok'){
 const payload=JSON.stringify({summary:'Exact Unicode 🌍 α \n'.repeat(4000),blocks:[{text:'<script>no execution</script>'}]});
 const bytes=new TextEncoder().encode(payload),chars=Array.from(payload);
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const delivery={id:'r',request_key:'session:1',complete:true,sha256,byte_length:bytes.length,origin:'oauth:test'};
 let calls=0;
 const fetcher=async(_input:any,init:any)=>{calls++;const b=JSON.parse(init.body);assertEquals(b.operation,'result');assertEquals(b.payload.request_key,'session:1');assertEquals(new Headers(init.headers).get('Authorization'),'Bearer test-oauth');
 if((mode==='revoked'&&b.payload.offset>0)||(mode==='final-denial'&&b.payload.limit===1))return Response.json({code:'RESULT_WITHHELD'},{status:403});
 const offset=b.payload.offset,end=Math.min(offset+b.payload.limit,chars.length);
 return Response.json({origin:'oauth:test',conversation_key:key,delivery:{...delivery,...(mode==='identity-change'&&offset>0?{id:'different'}:{})},automation:{final_receipt_id:'receipt'},transfer:{encoding:'unicode-characters',offset,next_offset:end===chars.length?null:end,total_characters:chars.length,text:chars.slice(offset,end).join('')+(mode==='corrupt'?'x':'')}})};
 return {payload,fetcher,calls:()=>calls};
}
Deno.test('full large Unicode payload bypasses model text and verifies through shared canonical reads',async()=>{const f=await fixture();const r=await callPersonalResult(args(),f.fetcher);assertEquals(r.isError,undefined);assertEquals((r._meta?.['neuralsynch/result']as any).payload,f.payload);assertEquals(r.content[0].text.length<1500,true);assertEquals(f.calls()>4,true)});
for(const mode of ['revoked','final-denial','identity-change','corrupt'])Deno.test('no partial payload on '+mode,async()=>{const f=await fixture(mode);const r=await callPersonalResult(args(),f.fetcher);assertEquals(r.isError,true);assertEquals(r._meta,undefined);assertEquals(r.structuredContent,undefined)});
Deno.test('result reader cannot gain tenant scope or accept caller credentials',async()=>{assertThrows(()=>bindToolArguments('memory_read',{},principal));const a=args();assertEquals(JSON.stringify(a).includes('test-oauth'),false);const r=await callPersonalResult({...a,__access_token:'spoof'});assertEquals(r.isError,true)});
Deno.test('protocol advertises static credential-free view and preserves private result metadata',async()=>{const server=new MCPServer();const r:any=await server.handleRequest({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:RESULT_RESOURCE.uri}});assertEquals(r.result.contents[0].mimeType,'text/html;profile=mcp-app');assertEquals(r.result.contents[0].text.includes('innerHTML'),false);assertEquals(r.result.contents[0]._meta.ui.csp.connectDomains,[]);
 const old=globalThis.fetch;const f=await fixture();globalThis.fetch=f.fetcher;try{const wire:any=await server.handleRequest({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'personal_result',arguments:{conversation_key:key,request_key:'session:1'}}},principal);assertEquals(wire.result._meta['neuralsynch/result'].payload,f.payload);assertEquals(wire.result.structuredContent.transport_verified,true)}finally{globalThis.fetch=old}});
