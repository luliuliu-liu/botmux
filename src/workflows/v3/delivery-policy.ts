/** 交付意图属于已审批的 Spec，不由 report.md 文件名或发布者决定。 */
export const WORKFLOW_DELIVERY_MODES = ['feishu-doc', 'archive-only'] as const;
export type WorkflowDeliveryMode = typeof WORKFLOW_DELIVERY_MODES[number];
export const WORKFLOW_POLICY_REGISTRATION_PATH = '/runs-with-delivery-policy';

export class WorkflowDeliveryPolicyError extends Error {
  constructor() { super('invalid_delivery_policy'); }
}

/** 缺失字段保持缺失，避免重写旧 Spec 时改变审批摘要。 */
export function parseWorkflowDeliveryMode(value: unknown): WorkflowDeliveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'feishu-doc' || value === 'archive-only') return value;
  throw new WorkflowDeliveryPolicyError();
}

/** 只读取登记时冻结的 Spec 原文；旧任务没有 Spec/字段时维持原有文档模式。 */
export function deliveryModeFromArtifacts(artifacts: unknown): WorkflowDeliveryMode | undefined {
  if (artifacts === undefined) return undefined;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) throw new WorkflowDeliveryPolicyError();
  const raw = (artifacts as Record<string, unknown>)['spec.json'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new WorkflowDeliveryPolicyError();
  let spec: unknown;
  try { spec = JSON.parse(raw); } catch { throw new WorkflowDeliveryPolicyError(); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new WorkflowDeliveryPolicyError();
  return parseWorkflowDeliveryMode((spec as Record<string, unknown>).deliveryMode);
}
