/**
 * Auth barrel — the Authorizer seam + scoped-token sign/verify/revocation.
 */

export { AutoApproveAuthorizer, defaultAuthorizer } from "./authorizer.ts";
export {
  TOKEN_LIFETIME_MS,
  TOKEN_SCHEME,
  REFRESH_GRACE_SECONDS,
  signToken,
  verifyToken,
  verifyTokenForRefresh,
  createRevocationRegistry,
  TokenExpiredError,
  TokenInvalidError,
} from "./tokens.ts";
export type { MintTokenInput, RevocationRegistry } from "./tokens.ts";
export { getSigningSecret, getInstanceId, _resetSecretCacheForTests } from "./secret.ts";
