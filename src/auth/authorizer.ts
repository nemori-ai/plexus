/**
 * The Authorizer seam (§4a, ADR-007 revised). The authorize decision is a
 * PLUGGABLE abstraction; swapping the policy never touches the wire.
 *
 * v1 default = `AutoApproveAuthorizer` — a permissive stub that returns "allow"
 * for the entry's requested verbs, so demos aren't blocked on a confirm-every-grant
 * UI. A stricter `UserConfirmAuthorizer` returning "pending" until the user confirms
 * in the management client is a drop-in replacement that exercises the
 * `grant_pending_user` + `GET /grants/status` path — no wire change.
 */

import type {
  Authorizer,
  AuthorizationContext,
  AuthorizationDecision,
} from "../protocol/index.ts";

/**
 * v1 permissive stub. Auto-approves the requested verbs for every entry.
 * Intentionally trivial — the SEAM (not this policy) is the contract.
 */
export class AutoApproveAuthorizer implements Authorizer {
  readonly policy = "auto-approve" as const;

  async authorize(ctx: AuthorizationContext): Promise<AuthorizationDecision> {
    return {
      id: ctx.entry.id,
      outcome: "allow",
      verbs: ctx.requestedVerbs,
      reason: "auto-approved (v1 permissive stub authorizer)",
    };
  }
}

/** The Authorizer the gateway uses by default in v1. */
export function defaultAuthorizer(): Authorizer {
  return new AutoApproveAuthorizer();
}
