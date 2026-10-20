import {expect,it} from 'vitest';
import {redactChildEnv,REDACTED_CHILD_ENV_KEYS} from '../src/utils/child-env.js';
it('removes platform resource/database authority while preserving scoped per-model environment',()=>{
  const keys=['CONTROL_PLANE_SYNC_KEY','CONTROL_PLANE_CONFIG_KEY','WORKFLOW_DATABASE_URL','WORKFLOW_API_KEY','SANDBOX_API_KEY'];
  const env=Object.fromEntries(keys.map(key=>[key,'private-platform-value']));
  const result=redactChildEnv({...env,PI_MODEL_API_KEY:'worker-scoped-key',PLATFORM_MODEL_API_KEY:'codex-scoped-key'});
  for(const key of keys){expect(REDACTED_CHILD_ENV_KEYS).toContain(key);expect(Object.hasOwn(result,key)).toBe(false);}
  expect(result.PI_MODEL_API_KEY).toBe('worker-scoped-key');expect(result.PLATFORM_MODEL_API_KEY).toBe('codex-scoped-key');
});
