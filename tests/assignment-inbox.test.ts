import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { assignmentIndication } from '../assignment-inbox.ts';
import { callCommitment } from '../commitment-tools.ts';
import { bindToolArguments } from '../auth.ts';
const principal={userId:'owner',accessToken:'synthetic',tenantRoles:new Map([['fixture.one','owner']])};
Deno.test('ordinary authenticated tool use automatically surfaces durable pending delivery without acknowledgment',async()=>{
 let calls=0;
 const fetcher:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assertEquals(body.p_operation,'inbox');assertEquals(body.p_client_id,'fixture.one');assertEquals(new Headers(init?.headers).get('Authorization'),'Bearer synthetic');return Response.json({schema:'neuralsynch.assignment-inbox.v1',pending:[{task_id:'stable-task',delivery_id:'stable-delivery'}]});};
 const first=await assignmentIndication('memory_stats',{client_id:'fixture.one'},principal,fetcher);
 const retry=await assignmentIndication('search',{client_id:'fixture.one'},principal,fetcher);
 assertEquals(first,retry);assertEquals(calls,2);assertEquals(first[0].text.includes('stable-task'),true);
});
Deno.test('no cross-tenant polling, recursive inbox, or fabricated success on revocation/failure',async()=>{
 const never=()=>{throw Error('must not fetch');};
 assertEquals(await assignmentIndication('search',{client_id:'foreign'},principal,never),[]);
 assertEquals(await assignmentIndication('commitment',{client_id:'fixture.one',payload:{action:'inbox'}},principal,never),[]);
 assertEquals(await assignmentIndication('search',{client_id:'fixture.one'},principal,async()=>Response.json({code:'denied'},{status:403})),[]);
 assertEquals(await assignmentIndication('search',{client_id:'fixture.one'},principal,async()=>{throw Error('offline');}),[]);
});
Deno.test('explicit acknowledgment carries original task and delivery IDs without task transition',async()=>{
 const payload={action:'acknowledge',id:'stable-task',delivery_id:'stable-delivery',request_id:'stable-request'};
 const r=await callCommitment(bindToolArguments('commitment',{client_id:'fixture.one',payload},principal),async(_url,init)=>{assertEquals(JSON.parse(String(init?.body)),{p_client_id:'fixture.one',p_operation:'acknowledge',p_input:{id:'stable-task',delivery_id:'stable-delivery',request_id:'stable-request'}});return Response.json({delivery:{task_id:'stable-task',acknowledged_at:'now'}});});
 assertEquals(r.isError,false);
});
