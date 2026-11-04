import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deliveryModeFromArtifacts} from '../src/workflows/v3/delivery-policy.js';
import {birthRun} from '../src/workflows/v3/grill-state.js';
import {hostSpecFinalize,hostApproveSpec,hostReviseSpec} from '../src/workflows/v3/host.js';
import {cloneWorkflow} from '../src/workflows/v3/operations.js';

it('只信冻结 Spec，缺失字段兼容旧任务，损坏或未知字段不回退发布',()=>{
 expect(deliveryModeFromArtifacts(undefined)).toBeUndefined();
 expect(deliveryModeFromArtifacts({'run.json':'{"deliveryMode":"archive-only"}'})).toBeUndefined();
 expect(deliveryModeFromArtifacts({'spec.json':'{"deliveryMode":"archive-only"}','run.json':'{"deliveryMode":"feishu-doc"}'})).toBe('archive-only');
 for(const spec of ['{broken','[]','null','{"deliveryMode":null}','{"deliveryMode":"other"}'])expect(()=>deliveryModeFromArtifacts({'spec.json':spec})).toThrow('invalid_delivery_policy');
});

it('clone 与 revise 保留 spec.md 中的仅归档选择',async()=>{
 const baseDir=mkdtempSync(join(tmpdir(),'delivery-clone-'));
 try{
  const source=birthRun({baseDir,runId:'archive-origin',goal:'归档测试'});
  const spec={schemaVersion:1,runId:source.runId,title:'归档测试',requirement:'只保留文件',deliveryMode:'archive-only',nodes:[{sketchId:'report',goal:'写文件',input_needs:[],expected_outputs:['report.md'],acceptance:'存在',risk_gate:false,unknowns:[]}]};
  writeFileSync(join(source.runDir,'spec.md'),'# 归档测试\n```json\n'+JSON.stringify(spec)+'\n```\n');
  hostSpecFinalize(source.runDir);hostApproveSpec(source.runDir);
  hostReviseSpec(source.runDir);hostSpecFinalize(source.runDir);
  expect(JSON.parse(readFileSync(join(source.runDir,'spec.json'),'utf8')).deliveryMode).toBe('archive-only');
  const cloned=await cloneWorkflow(source.runId,{baseDir});hostSpecFinalize(cloned.runDir);
  expect(JSON.parse(readFileSync(join(cloned.runDir,'spec.json'),'utf8'))).toMatchObject({runId:cloned.runId,deliveryMode:'archive-only'});
 }finally{rmSync(baseDir,{recursive:true,force:true});}
});
