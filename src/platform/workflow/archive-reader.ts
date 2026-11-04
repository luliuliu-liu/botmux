import {existsSync,lstatSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {atomicWriteFileSync} from '../../utils/atomic-write.js';
import {platformRequest,platformManagementEnabled} from '../management/dashboard-api.js';
import type {ArchiveArtifact,ArchiveLifecycle,ArchiveSummary,RetentionArchiveRow,RetentionArchives} from './archive-contract.js';

type PlatformResult={status:number;data:any};
type CachedRow=Pick<RetentionArchiveRow,'runId'|'revision'|'state'|'archiveHash'|'summary'|'files'>;
type Cache={schema:'botmux-workflow-archive-index-v1';rows:CachedRow[]};
export type ArchiveRead={state:ArchiveLifecycle;row:CachedRow};
export class ArchiveReadUnavailable extends Error{constructor(readonly status:number,readonly code='archive_gateway_unavailable'){super(code);}}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const validState=(value:unknown):value is ArchiveLifecycle=>['live','archiving','archive_verified','compacted'].includes(String(value));
function safeRows(value:any):CachedRow[]{
 if(!value||value.schema!=='acp-retention-archives-v1'||value.automaticCleanup!==false||!Array.isArray(value.rows))throw new ArchiveReadUnavailable(502,'invalid_archive_response');
 return value.rows.map((row:any)=>{if(!validId(row?.runId)||!validState(row.state)||!Number.isSafeInteger(row.revision)||!Array.isArray(row.files)||!row.files.every((file:any)=>/^[a-f0-9]{64}$/.test(file?.key)&&typeof file.path==='string'&&typeof file.nodeId==='string')||(archived(row)&&row.summary&&(row.summary.readOnly!==true||row.summary.logsArchived!==false)))throw new ArchiveReadUnavailable(502,'invalid_archive_response');return {runId:row.runId,revision:row.revision,state:row.state,archiveHash:typeof row.archiveHash==='string'?row.archiveHash:null,summary:row.summary??null,files:row.files};});
}
function archived(row:CachedRow){return row.state==='archive_verified'||row.state==='compacted';}
export class ArchiveReader{
 private rows=new Map<string,CachedRow>();
 constructor(private deps:{runsDir:string;active?:boolean;request?:(path:string)=>Promise<PlatformResult>;rawRequest?:(path:string)=>Promise<Response>}){
  this.loadCache();
 }
 private get active(){return this.deps.active??platformManagementEnabled();}
 private get cachePath(){return join(dirname(this.deps.runsDir),'platform','workflow-archive-index.json');}
 private loadCache(){
  try{if(!existsSync(this.cachePath)||!lstatSync(this.cachePath).isFile()||lstatSync(this.cachePath).isSymbolicLink())return;const value=JSON.parse(readFileSync(this.cachePath,'utf8')) as Cache;if(value.schema!=='botmux-workflow-archive-index-v1'||!Array.isArray(value.rows))return;for(const row of value.rows)if(validId(row.runId)&&validState(row.state)&&archived(row))this.rows.set(row.runId,row);}catch{/* A damaged cache grants no archive authority. */}
 }
 private save(){mkdirSync(dirname(this.cachePath),{recursive:true,mode:0o700});atomicWriteFileSync(this.cachePath,JSON.stringify({schema:'botmux-workflow-archive-index-v1',rows:[...this.rows.values()].filter(archived)} satisfies Cache),{mode:0o600,followTargetSymlink:false});}
 async refresh():Promise<Map<string,CachedRow>>{
  if(!this.active)return new Map();
  let result:PlatformResult;try{result=this.deps.request?await this.deps.request('/workflow-retention/archives'):await platformRequest('/workflow-retention/archives');}catch{throw new ArchiveReadUnavailable(503);}
  if(result.status!==200)throw new ArchiveReadUnavailable(result.status===404?503:result.status);
  const rows=safeRows(result.data as RetentionArchives),authorized=new Map(rows.map(row=>[row.runId,row])),next=new Map(authorized);
  for(const [id,row] of this.rows)if(row.state==='compacted'&&!next.has(id))next.set(id,row);
  this.rows=next;try{this.save();}catch{/* The live gateway result remains authoritative for this request. */}
  return authorized;
 }
 async lookup(runId:string):Promise<ArchiveRead|null>{
  if(!validId(runId)||!this.active)return null;
  let result:PlatformResult;const path='/workflow-retention/archives/'+encodeURIComponent(runId);
  try{result=this.deps.request?await this.deps.request(path):await platformRequest(path);}catch{throw new ArchiveReadUnavailable(503);}
  if(result.status===404){if(this.rows.get(runId)?.state==='compacted')throw new ArchiveReadUnavailable(503,'archive_index_missing');return null;}
  if(result.status!==200)throw new ArchiveReadUnavailable(result.status);
  const row=safeRows(result.data).find(r=>r.runId===runId);if(!row)throw new ArchiveReadUnavailable(502,'invalid_archive_response');
  this.rows.set(runId,row);try{this.save();}catch{}
  return {state:row.state,row};
 }
 cached(runId:string):ArchiveRead|null{const row=this.rows.get(runId);return row?{state:row.state,row}:null;}
 async file(runId:string,key:string):Promise<Response>{
  if(!validId(runId)||!/^[a-f0-9]{64}$/.test(key))return new Response(null,{status:404});
  if(this.deps.rawRequest)return this.deps.rawRequest(`/workflow-retention/archives/${encodeURIComponent(runId)}/files/${key}`);
  const base=process.env.CONTROL_PLANE_URL?.trim(),token=process.env.CONTROL_PLANE_SYNC_KEY?.trim();if(!base||!token)throw new ArchiveReadUnavailable(503);
  try{return await fetch(`${base.replace(/\/$/,'')}/internal/v1/platform/workflow-retention/archives/${encodeURIComponent(runId)}/files/${key}`,{headers:{'x-api-key':token,'x-platform-gateway-id':process.env.BOTMUX_PLATFORM_GATEWAY_ID||'local-gateway','x-platform-gateway-key':process.env.BOTMUX_PLATFORM_GATEWAY_KEY||''},redirect:'error',signal:AbortSignal.timeout(180000)});}catch{throw new ArchiveReadUnavailable(503);}
 }
}
export function archivedOperations(row:CachedRow){const summary=row.summary as ArchiveSummary|null;return {runId:row.runId,runStatus:summary?.runStatus??'unknown',phase:'archived',readOnly:true,logsArchived:false,nextAction:'此运行已归档，只能查看摘要和归档文件',jobs:summary?.jobs??[],reportDelivery:summary?.reportDelivery??null,authoringApprovals:[],lineage:null};}
export function archivedFiles(row:CachedRow){return (row.files as ArchiveArtifact[]).map(({blob:_,...file})=>({...file,url:`/api/v3/runs/${encodeURIComponent(row.runId)}/artifacts/${file.key}`}));}
