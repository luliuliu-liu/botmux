/** 与通用授权分离，旧接收端缺少此路径时必须失败，不降级。 */
export const WORKFLOW_CHAT_GRANT_PATH='/api/grants/workflow-chat';
export interface WorkflowLaunchGrantLease {leaseId:string;subjectOpenId:string}
