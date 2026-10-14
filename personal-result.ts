import { callPersonalCapability } from "./personal-tools.ts";
import type { MCPToolResult } from "./memory-tools.ts";
import { RESULT_RESOURCE } from "./result-view.ts";

export const PERSONAL_RESULT_SCHEMA = {
  name: "personal_result",
  title: "Open complete NeuralSynch result",
  description:
    "Use this after a completed Personal capability invocation, or to recover that result in this conversation. For Concept Lab use concept_id and version instead of request_key; optional format canonical, docx or pdf retrieves the exact governed Blueprint. Opens the full byte-verified result inside the hosted interface using the shared NeuralSynch viewer. Rechecks current session, source and authority; never executes a provider or debits NUU. Reuse the original conversation_key and delivery.request_key. The complete bytes go directly to the viewer; do not reconstruct them from model text. A client without MCP Apps support has not established complete hosted delivery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_key: { type: "string", format: "uuid" },
      concept_id: {type:"string",format:"uuid"},
      version: {type:"integer",minimum:1},
      format: {type:"string",enum:["canonical","docx","pdf"]},
      request_key: { type: "string", minLength: 1 },
    },
    required: ["conversation_key"],
    oneOf:[{required:["request_key"]},{required:["concept_id","version"]}],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    ui: { resourceUri: RESULT_RESOURCE.uri, visibility: ["model", "app"] },
  },
};

const encoder = new TextEncoder();
export async function callPersonalResult(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  if (args.concept_id !== undefined) return callConceptResult(args, fetcher);
  const denied = (code: string): MCPToolResult => ({
    content: [{ type: "text", text: JSON.stringify({ code }) }],
    isError: true,
  });
  if (
    Object.keys(args).some((k) =>
      !["conversation_key", "request_key"].includes(k)
    ) ||
    typeof args.conversation_key !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.conversation_key,
    ) ||
    typeof args.request_key !== "string" || !args.request_key ||
    args.request_key.length > 200 || typeof args.__access_token !== "string"
  ) return denied("CLIENT_CONTEXT_REJECTED");
  const page = async (offset: number, limit = 16000) => {
    const bound = {
      operation: "result",
      conversation_key: args.conversation_key,
      payload: { request_key: args.request_key, offset, limit },
    };
    Object.defineProperty(bound, "__access_token", {
      value: args.__access_token,
    });
    const r = await callPersonalCapability(bound, fetcher);
    if (r.isError) throw new Error("RESULT_WITHHELD");
    return JSON.parse(r.content[0].text);
  };
  try {
    let offset = 0, text = "", first: any;
    for (let n = 0; n < 512; n++) {
      const p = await page(offset), t = p.transfer, d = p.delivery;
      if (!first) first = p;
      if (
        !d?.complete || d.request_key !== args.request_key ||
        !/^[a-f0-9]{64}$/.test(d.sha256) ||
        !Number.isSafeInteger(d.byte_length) || d.byte_length < 1 ||
        d.byte_length > 8 * 1024 * 1024 ||
        JSON.stringify(d) !== JSON.stringify(first.delivery) ||
        p.origin !== first.origin ||
        p.conversation_key !== args.conversation_key ||
        t?.encoding !== "unicode-characters" || t.offset !== offset ||
        t.total_characters !== first.transfer.total_characters ||
        typeof t.text !== "string"
      ) throw new Error("RESULT_INTEGRITY_FAILED");
      text += t.text;
      offset += Array.from(t.text).length;
      if (encoder.encode(text).length > d.byte_length) {
        throw new Error("RESULT_INTEGRITY_FAILED");
      }
      if (t.next_offset === null) {
        if (offset !== t.total_characters) {
          throw new Error("RESULT_INTEGRITY_FAILED");
        }
        const bytes = encoder.encode(text);
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ).map((x) => x.toString(16).padStart(2, "0")).join("");
        if (bytes.length !== d.byte_length || sha256 !== d.sha256) {
          throw new Error("RESULT_INTEGRITY_FAILED");
        }
        // Final fresh canonical read: changes during assembly withhold the entire result.
        const final = await page(0, 1);
        if (
          JSON.stringify(final.delivery) !== JSON.stringify(d) ||
          final.origin !== first.origin
        ) throw new Error("RESULT_WITHHELD");
        const manifest = {
          schema: "neuralsynch.hosted-result.v1",
          conversation_key: args.conversation_key,
          delivery: d,
          automation: final.automation,
          transport_verified: true,
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...manifest,
              presentation:
                "Complete result supplied directly to the hosted viewer. Viewer verifies bytes independently; do not infer rendered success from this receipt alone.",
            }),
          }],
          structuredContent: manifest,
          _meta: { "neuralsynch/result": { ...manifest, payload: text } },
        };
      }
      if (t.next_offset !== offset || !t.text) {
        throw new Error("RESULT_INTEGRITY_FAILED");
      }
    }
    return denied("RESULT_TRANSFER_LIMIT");
  } catch (e) {
    return denied(
      e instanceof Error && e.message === "RESULT_INTEGRITY_FAILED"
        ? e.message
        : "RESULT_WITHHELD",
    );
  }
}

/** Read existing Concept custody through the native authenticated path. No model
 * assembles document bytes, and binary payloads never enter model context. */
async function callConceptResult(args: Record<string, unknown>, fetcher: typeof fetch): Promise<MCPToolResult> {
  const fail = (code:string) => ({content:[{type:"text" as const,text:JSON.stringify({code})}],isError:true});
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const format=args.format??"canonical";
  if(Object.keys(args).some(k=>!["conversation_key","concept_id","version","format"].includes(k)) ||
    !uuid.test(String(args.conversation_key)) || !uuid.test(String(args.concept_id)) ||
    !Number.isSafeInteger(args.version) || Number(args.version)<1 || !["canonical","docx","pdf"].includes(String(format)) ||
    typeof args.__access_token!=="string") return fail("CLIENT_CONTEXT_REJECTED");
  const call=async(operation:string,payload:Record<string,unknown>)=>{
    const bound={operation,conversation_key:args.conversation_key,payload};
    Object.defineProperty(bound,"__access_token",{value:args.__access_token});
    const r=await callPersonalCapability(bound,fetcher);
    if(r.isError)throw Error("RESULT_WITHHELD");
    return r;
  };
  try {
    const session=JSON.parse((await call("session",{})).content[0].text).session;
    const base={id:args.concept_id,version:args.version,expectedVersion:session.stateVersion};
    const check = async () => {
      const state = JSON.parse((await call("concept", {...base, action:"get"})).content[0].text).workspace;
      if (state?.project?.id !== args.concept_id || state?.version?.version !== args.version || !Array.isArray(state?.steps) || state.steps.some((s: {status:string}) => s.status === "withheld")) throw Error("RESULT_WITHHELD");
    };
    await check();
    const result=await call("concept",{...base,action:"export",format});
    let payload=result.content[0].text, encoding="utf-8",media_type="application/json", bytes:Uint8Array;
    if(format!=="canonical"){
      const artifact=JSON.parse(payload);
      if(!artifact.complete||artifact.encoding!=="base64")throw Error("RESULT_INTEGRITY_FAILED");
      payload=artifact.data;encoding="base64";media_type=artifact.media_type;
      bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0));
    } else {JSON.parse(payload);bytes=new TextEncoder().encode(payload);}
    if(bytes.length>8*1024*1024)throw Error("RESULT_TRANSFER_LIMIT");
    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes)))).map(x=>x.toString(16).padStart(2,"0")).join("");
    await check();
    const locator={conversation_key:args.conversation_key,concept_id:args.concept_id,version:args.version};
    const manifest={schema:"neuralsynch.hosted-result.v1",...locator,format,encoding,media_type,
      delivery:{id:args.concept_id,request_key:`concept:${args.concept_id}:${args.version}:${format}`,complete:true,sha256,byte_length:bytes.length},transport_verified:true};
    return {content:[{type:"text",text:JSON.stringify({...manifest,presentation:"Complete governed Blueprint supplied directly to the viewer. Do not reconstruct it from model text."})}],structuredContent:manifest,
      _meta:{"neuralsynch/result":{...manifest,payload}}};
  }catch(e){return fail(e instanceof Error && e.message==="RESULT_INTEGRITY_FAILED"?e.message:"RESULT_WITHHELD");}
}
