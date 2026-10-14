// Loaded into the existing MCP Apps document; only host-mediated tool calls.
export const WORKFLOW_SCRIPT = `
let workflow=null, workflowBusy=false, workflowStop=false, workflowClosed=false;
const tracker=document.getElementById('workflow'), buildButton=document.getElementById('workflow-build'), pauseButton=document.getElementById('workflow-pause');
function workflowText(parent,tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;parent.append(el);return el}
function renderWorkflowTracker(s,running=false,message){
tracker.style.setProperty('--ns-workflow-count',Math.max(1,Math.min(6,s.milestones.length)));tracker.hidden=false;tracker.dataset.state=running?'running':s.state;tracker.replaceChildren();
 const mark=document.createElement('div');mark.className='ns-workflow-wave';mark.setAttribute('aria-hidden','true');const img=document.createElement('img');img.src=WORKFLOW_LOGO;img.alt='';img.width=64;img.height=42;mark.append(img);tracker.append(mark);
 const body=document.createElement('div');body.className='ns-workflow-body';tracker.append(body);const head=document.createElement('div');head.className='ns-workflow-header';body.append(head);workflowText(head,'strong',s.title);workflowText(head,'small',s.recovery);
 const status=workflowText(body,'p',message||(running?'Building '+s.milestones.find(m=>m.state!=='complete')?.label:s.activity),'ns-workflow-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');statusEl.textContent=status.textContent;
 const list=document.createElement('ol');list.className='ns-workflow-milestones';body.append(list);let active=false;
 for(const m of s.milestones){const li=document.createElement('li');const current=running&&!active&&m.state!=='complete';if(current)active=true;li.dataset.state=current?'active':m.state;if(current)li.setAttribute('aria-current','step');const node=workflowText(li,'span',m.state==='complete'?'✓':'','ns-workflow-node');node.setAttribute('aria-hidden','true');const label=workflowText(li,'span',m.label);workflowText(label,'span',' — '+li.dataset.state,'ns-workflow-sr');list.append(li)}
}
function showWorkflow(v,running=false,message){
 const s=v.snapshot;renderWorkflowTracker(s,running,message);
 buildButton.hidden=s.state==='complete';buildButton.disabled=workflowBusy||s.state==='blocked';buildButton.textContent=s.state==='paused'?'Recover and continue Blueprint':'Build remaining Blueprint';pauseButton.hidden=!running;
 refresh.disabled=workflowBusy;for(const id of ['word','pdf'])document.getElementById(id).disabled=workflowBusy||s.state!=='complete';
}
function showSavedSections(w){resultEl.replaceChildren();for(const step of w.steps||[]){if(step.status!=='complete')continue;for(const section of step.response?.concept?.sections||[]){const details=document.createElement('details');workflowText(details,'summary',section.heading);if(section.body)workflowText(details,'p',section.body);for(const b of section.blocks||[]){if(b.text)workflowText(details,'p',b.text);if(b.items){const list=document.createElement(b.type==='numbered'?'ol':'ul');for(const text of b.items)workflowText(list,'li',text);details.append(list)}if(b.columns){const wrap=document.createElement('div');wrap.style.overflowX='auto';const table=document.createElement('table');for(const [i,row]of [b.columns,...b.rows].entries()){const tr=document.createElement('tr');for(const text of row)workflowText(tr,i===0?'th':'td',text);table.append(tr)}wrap.append(table);details.append(wrap)}}resultEl.append(details)}}}
async function readWorkflow(action='status',stage){
 const args={...locator,action};if(stage)args.stage=stage;
 const r=await rpc('tools/call',{name:'personal_workflow',arguments:args}),v=r._meta?.['neuralsynch/workflow'];
 if(r.isError||!v||v.concept_id!==locator.concept_id||v.version!==locator.version||v.conversation_key!==locator.conversation_key)throw Error('Workflow paused or access changed. Recover saved progress before continuing.');
 if(workflowClosed)return null;workflow=v;showWorkflow(v);showSavedSections(v.workspace);return v;
}
async function recoverWorkflow(){if(workflowBusy||busy||workflowClosed)return;workflowBusy=true;syncControls();let complete=false;try{await readWorkflow();complete=workflow.snapshot.state==='complete'}catch(e){clear(e.message);tracker.hidden=true}finally{workflowBusy=false;syncControls()}if(complete)await recover()}
buildButton.onclick=async()=>{
 if(workflowBusy||busy||workflowClosed)return;workflowBusy=true;workflowStop=false;buildButton.disabled=true;pauseButton.disabled=false;pauseButton.textContent='Pause after this stage';
 try{let v=await readWorkflow();for(let n=0;n<5&&!workflowStop&&!workflowClosed&&v?.next_stage;n++){
  if(v.snapshot.state==='blocked')throw Error('Current access or version requires review.');
  showWorkflow(v,true);v=await readWorkflow('advance',v.next_stage);
 }if(workflowClosed)return;if(v)showWorkflow(v,false,workflowStop&&v.next_stage?'Paused — completed work saved':undefined);
 }catch(e){clear(e.message);tracker.hidden=true;}
 finally{workflowBusy=false;refresh.disabled=false;pauseButton.hidden=true;buildButton.disabled=false;for(const id of ['word','pdf'])document.getElementById(id).disabled=workflow?.snapshot.state!=='complete';if(!workflowClosed&&workflow?.snapshot.state==='complete')await recover()}
};
pauseButton.onclick=()=>{workflowStop=true;pauseButton.disabled=true;pauseButton.textContent='Pausing after this stage…'};
`;
