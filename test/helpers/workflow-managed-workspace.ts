import {createHash} from 'node:crypto';
import {canonicalJsonStringify} from '../../src/utils/canonical-json.js';
import type {ProjectWorkspaceBinding} from '../../src/platform/workflow/project-workspace.js';

/** 合成的权威工作区回执；HTTP/daemon/草稿服务真实运行，宿主探针在联合测试验证。 */
export function managedWorkspaceBinding():ProjectWorkspaceBinding {
 const value={schema:'workflow-project-workspace-v1' as const,poolId:'11111111-1111-4111-8111-111111111111',kind:'hostpath' as const,claim:'/data/agents/project-a',executionMode:'pool' as const,controlRelativeRoot:'project-a',controlRoot:{kind:'hostpath' as const,claim:'/data/agents'},accessEvidence:{root:{realPath:'/data/agents',device:'1',inode:'2'},target:{realPath:'/data/agents/project-a',device:'1',inode:'3'}}};
 return {...value,bindingHash:createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')};
}
