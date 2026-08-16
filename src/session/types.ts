// Session — Type definitions for server-anchored sessions
//
// Clients declare what they are; the server resolves effective policy.
// This moves identity and policy from client-supplied to server-enforced.

export type TrustLevel = 'verified' | 'user_facing' | 'background_agent' | 'untrusted';

export interface ClientCapabilities {
  can_tag_sensitivity: boolean;
  can_provide_intent: boolean;
  can_request_user_confirmation: boolean;
}

export type WriteMode = 'off' | 'explicit_only' | 'durable_summary' | 'auto';
export type ReadMode = 'off' | 'on_demand' | 'always';
export type SensitiveHandling = 'never' | 'confirm_via_client' | 'server_redact' | 'allowed';

export interface EffectivePolicy {
  write_mode: WriteMode;
  read_mode: ReadMode;
  sensitive_handling: SensitiveHandling;
  default_scope_routing: {
    project?: string;
    personal?: string;
    workspace?: string;
  };
  write_async: boolean;
}

export interface Session {
  id: string;                      // session_<ulid>
  client_id: string;
  client_version: string;
  actor_id: string;                // resolved server-side
  declared_trust_level: TrustLevel;
  effective_trust_level: TrustLevel;
  declared_capabilities: ClientCapabilities;
  effective_policy: EffectivePolicy;
  requested_scopes: string[];
  capabilities_granted: string[];
  policy_version: string;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  status: 'active' | 'ended' | 'expired';
}
