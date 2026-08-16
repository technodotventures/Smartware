// Session — In-memory session store with SQLite persistence
//
// Sessions are short-lived (default 24h) and keyed by session_id.
// The store resolves session_id → actor_id for downstream handlers.

import Database from 'better-sqlite3';
import type { Session, TrustLevel, EffectivePolicy, ClientCapabilities } from './types.js';
import { dirname } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  declared_trust_level TEXT NOT NULL,
  effective_trust_level TEXT NOT NULL,
  declared_capabilities TEXT NOT NULL,
  effective_policy TEXT NOT NULL,
  requested_scopes TEXT NOT NULL DEFAULT '[]',
  capabilities_granted TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_session_actor ON sessions(actor_id);
CREATE INDEX IF NOT EXISTS idx_session_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_client ON sessions(client_id);
`;

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  insert(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions
        (id, client_id, client_version, actor_id,
         declared_trust_level, effective_trust_level,
         declared_capabilities, effective_policy,
         requested_scopes, capabilities_granted,
         policy_version, created_at, expires_at, ended_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.client_id, session.client_version, session.actor_id,
      session.declared_trust_level, session.effective_trust_level,
      JSON.stringify(session.declared_capabilities),
      JSON.stringify(session.effective_policy),
      JSON.stringify(session.requested_scopes),
      JSON.stringify(session.capabilities_granted),
      session.policy_version, session.created_at, session.expires_at,
      session.ended_at, session.status,
    );
  }

  get(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const session = this.rowToSession(row);

    // Auto-expire
    if (session.status === 'active' && new Date(session.expires_at) < new Date()) {
      this.db.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").run(sessionId);
      session.status = 'expired';
    }

    return session;
  }

  /** Get an active, non-expired session or null */
  getActive(sessionId: string): Session | null {
    const session = this.get(sessionId);
    if (!session) return null;
    if (session.status !== 'active') return null;
    return session;
  }

  end(sessionId: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'",
    ).run(new Date().toISOString(), sessionId);
    return result.changes > 0;
  }

  /** Get all active sessions for an actor */
  getByActor(actorId: string): Session[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE actor_id = ? AND status = 'active'",
    ).all(actorId) as Record<string, unknown>[];
    return rows.map(r => this.rowToSession(r));
  }

  /** Count active sessions */
  activeCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE status = 'active'",
    ).get() as { count: number };
    return row.count;
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row['id'] as string,
      client_id: row['client_id'] as string,
      client_version: row['client_version'] as string,
      actor_id: row['actor_id'] as string,
      declared_trust_level: row['declared_trust_level'] as TrustLevel,
      effective_trust_level: row['effective_trust_level'] as TrustLevel,
      declared_capabilities: JSON.parse(row['declared_capabilities'] as string) as ClientCapabilities,
      effective_policy: JSON.parse(row['effective_policy'] as string) as EffectivePolicy,
      requested_scopes: JSON.parse(row['requested_scopes'] as string) as string[],
      capabilities_granted: JSON.parse(row['capabilities_granted'] as string) as string[],
      policy_version: row['policy_version'] as string,
      created_at: row['created_at'] as string,
      expires_at: row['expires_at'] as string,
      ended_at: row['ended_at'] as string | null,
      status: row['status'] as Session['status'],
    };
  }

  close(): void {
    this.db.close();
  }
}
