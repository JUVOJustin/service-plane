import { MachineAuthError } from '../shared/errors.js';
import { verifyMachineRequest as verifyRequest } from '../shared/crypto.js';
import {
  SERVICE_PLANE_AUTH_CONTEXT,
  type MachineAuthContext,
  type MachineAuthContextSource,
  type MachineAuthMiddleware,
  type VerifyMachineRequestOptions,
} from '../shared/types.js';

export { verifyRequest as verifyMachineRequest };

export function machineAuth(options: VerifyMachineRequestOptions): MachineAuthMiddleware {
  return async (context, next) => {
    try {
      const identity = await verifyRequest(context.req.raw, options);
      context.set(SERVICE_PLANE_AUTH_CONTEXT, identity);
      await next();
    } catch (error) {
      if (error instanceof MachineAuthError) return context.json({ error: error.message }, 401);
      throw error;
    }
  };
}

export function machineIdentity(context: MachineAuthContextSource): MachineAuthContext | undefined {
  return context.get(SERVICE_PLANE_AUTH_CONTEXT);
}
