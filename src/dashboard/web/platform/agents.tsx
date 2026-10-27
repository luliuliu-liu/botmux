import {mountReactPage} from '../react-mount.js';
import {ui} from '../ui.js';
import {ManagementPage} from './management-page.js';
import {AGENT_SECTIONS,ManagementLayout,useManagementSection} from './management-layout.js';

export function AgentsManagement({initial='instances'}:{initial?:string}){
  const section=useManagementSection(AGENT_SECTIONS,initial);
  if(!ui.platformManaged)return <section className="page"><h1>平台管理未启用</h1></section>;
  return <ManagementLayout title="Agent 管理" description="管理 Agent 实例、机器人与运行资源" route="#/platform-agents" sections={AGENT_SECTIONS} section={section}>
    <ManagementPage page={section==='bots'?'bots':'agents'} embedded agentSection={section}/>
  </ManagementLayout>;
}
export function renderAgentsPage(root:HTMLElement){return mountReactPage(root,<AgentsManagement/>);}
export function renderBotsPage(root:HTMLElement){return mountReactPage(root,<AgentsManagement initial="bots"/>);}
