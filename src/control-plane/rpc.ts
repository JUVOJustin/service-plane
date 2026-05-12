import { CapabilityAuthError } from '../shared/errors.js';
import type { IssueCapabilityTokenInput, IssuedCapabilityToken } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';

export type IssueCapabilityTokenForCallerInput = Omit<IssueCapabilityTokenInput, 'callerServiceId'> & {
  callerServiceId?: string;
};

export type RpcIssuedCapabilityToken = {
  expiresAt: string;
  token: string;
  tokenType: 'ServicePlane';
};

// Supports private platform RPC entrypoints where deployment config establishes the caller.
export async function issueCapabilityTokenForCaller(
  issuer: CapabilityIssuer,
  callerServiceId: string,
  input: IssueCapabilityTokenForCallerInput,
): Promise<RpcIssuedCapabilityToken> {
  if (input.callerServiceId && input.callerServiceId !== callerServiceId) {
    throw new CapabilityAuthError('Caller service mismatch', 403);
  }
  const issued = await issuer.issueCapabilityToken({
    callerServiceId,
    scopes: input.scopes,
    targetServiceId: input.targetServiceId,
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
  });
  return issuedCapabilityTokenRpcResponse(issued);
}

export function issuedCapabilityTokenRpcResponse(issued: IssuedCapabilityToken): RpcIssuedCapabilityToken {
  return {
    expiresAt: issued.expiresAt.toISOString(),
    token: issued.token,
    tokenType: 'ServicePlane',
  };
}
