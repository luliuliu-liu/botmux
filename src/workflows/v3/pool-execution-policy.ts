import type { V3Dag, V3Node } from './dag.js';
import type { PrepareResource } from './execution-backend.js';

/** Pool selection is an execution requirement, including inside loop bodies. */
export function requiresAgentPool(dag: V3Dag): boolean {
  const required = (node: V3Node): boolean => Boolean(node.agentSelection)
    || Boolean(node.body?.nodes.some(required));
  return dag.nodes.some(required);
}

/** 新的 Dashboard launch/模板提交在写运行授权前复用同一互斥边界。 */
export function assertExternalBotExecutionAvailable(dag: V3Dag, backend?: { resourceManaged?: () => boolean }): void {
  if (requiresAgentPool(dag) || backend?.resourceManaged?.()) {
    throw new Error('agent_pool_external_executor_conflict: 托管 Agent 池不能使用外部 Bot 执行方式');
  }
}

export function assertPoolExecutionAvailable(dag: V3Dag, backend?: { prepareResource?: PrepareResource }): void {
  if (requiresAgentPool(dag) && !backend?.prepareResource) {
    throw new Error('agent_pool_backend_required: 此 DAG 要求 Agent 池，但当前进程没有托管执行后端。请通过已审批 Workflow 的 botmux workflow start <runId> 启动；禁止回退为本地执行。');
  }
}
