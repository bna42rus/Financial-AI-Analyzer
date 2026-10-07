import { serializeSignedCookie } from 'better-call';
import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { token, digest, hashPassword, verifyPassword } from './crypto.ts';
import { realm, fields, string, email, password, HttpError, event, outbox } from './types.ts';
import type { Config, Sealer } from './types.ts';
import type { Auth } from './auth.ts';

const dummyPasswordHash = hashPassword(token());

export async function resetRequest(db: PoolClient, config: Config, request: FastifyRequest, seal: Sealer) {
  const input = fields(request, ['email']), address = email(input.email), schema = realm(config.profile);
  const user = (await db.query(`SELECT u.id,u.email,s.epoch FROM ${schema}.auth_user u JOIN ${schema}.security_state s ON s.user_id=u.id WHERE u.email=$1 AND u.email_verified=true`, [address])).rows[0];
  if (user) {
    const secret = token();
    await db.query(`INSERT INTO ${schema}.reset_token(verifier,user_id,epoch,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')`, [digest(secret), user.id, user.epoch]);
    await outbox(db, schema, seal, 'password_reset', { email: address, token: secret, profile: config.profile });
  }
  return { status: 'accepted' }; // Same response for absent and unverified addresses.
}
export async function resetPassword(db: PoolClient, config: Config, request: FastifyRequest, seal: Sealer) {
  const input = fields(request, ['token', 'newPassword']), secret = string(input.token, 100), nextPassword = password(input.newPassword), schema = realm(config.profile);
  const entry = (await db.query(`SELECT r.*,u.email FROM ${schema}.reset_token r JOIN ${schema}.security_state s ON s.user_id=r.user_id
    JOIN ${schema}.auth_user u ON u.id=r.user_id WHERE r.verifier=$1 AND r.consumed_at IS NULL AND r.expires_at>now() AND r.epoch=s.epoch AND u.email_verified=true FOR UPDATE OF r,s`, [digest(secret)])).rows[0];
  if (!entry) throw new HttpError(400, 'INVALID_TOKEN');
  await db.query(`UPDATE ${schema}.auth_account SET password=$1,updated_at=now() WHERE user_id=$2 AND provider_id='credential'`, [await hashPassword(nextPassword), entry.user_id]);
  await db.query(`UPDATE ${schema}.security_state SET epoch=epoch+1 WHERE user_id=$1`, [entry.user_id]);
  await db.query(`DELETE FROM ${schema}.auth_session WHERE user_id=$1`, [entry.user_id]);
  await db.query(`DELETE FROM ${schema}.reset_token WHERE user_id=$1`, [entry.user_id]);
  await db.query(`DELETE FROM ${schema}.auth_verification WHERE value=$1`, [entry.user_id]);
  await event(db, schema, entry.user_id, 'password_reset');
  await outbox(db, schema, seal, 'security_password_changed', { email: entry.email });
  return { status: 'login_required' };
}
export async function recoverAdmin(auth: Auth, db: PoolClient, config: Config, request: FastifyRequest, seal: Sealer) {
  const input = fields(request, ['email', 'password', 'recoveryCode']), address = email(input.email), pw = string(input.password, 128), code = string(input.recoveryCode, 100);
  const user = (await db.query(`SELECT u.*,a.password,s.epoch,s.status FROM control.auth_user u JOIN control.auth_account a ON a.user_id=u.id AND a.provider_id='credential'
    JOIN control.security_state s ON s.user_id=u.id WHERE u.email=$1 FOR UPDATE OF s`, [address])).rows[0];
  // Dummy Argon2 work preserves the absent-address path; generated once at startup, never returned.
  const valid = await verifyPassword(pw, user?.password ?? await dummyPasswordHash);
  if (!user || !valid || !user.email_verified || user.status !== 'active') throw new HttpError(401, 'INVALID_CREDENTIALS');
  const used = await db.query(`UPDATE control.recovery_code SET consumed_at=now() WHERE verifier=$1 AND user_id=$2 AND consumed_at IS NULL RETURNING verifier`, [digest(code), user.id]);
  if (!used.rowCount) throw new HttpError(401, 'INVALID_CREDENTIALS');
  await db.query('DELETE FROM control.auth_session WHERE user_id=$1', [user.id]);
  await db.query('DELETE FROM control.auth_verification WHERE value=$1 OR value IN (SELECT id FROM control.auth_two_factor WHERE user_id=$1)', [user.id]);
  await db.query('DELETE FROM control.auth_two_factor WHERE user_id=$1', [user.id]);
  await db.query('UPDATE control.auth_user SET two_factor_enabled=false,updated_at=now() WHERE id=$1', [user.id]);
  await db.query('UPDATE control.security_state SET epoch=epoch+1,bootstrap_pending=false WHERE user_id=$1', [user.id]);
  // All codes of the old enrollment become invalid; a new set is issued after verified enrollment.
  await db.query('UPDATE control.recovery_code SET consumed_at=coalesce(consumed_at,now()) WHERE user_id=$1', [user.id]);
  await db.query('DELETE FROM control.reset_token WHERE user_id=$1', [user.id]);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(user.id, false);
  if (!session) throw new Error('Session creation failed');
  await db.query(`UPDATE control.auth_session SET expires_at=now()+interval '10 minutes' WHERE id=$1`, [session.id]);
  await db.query(`INSERT INTO control.session_proof(session_id,user_id,epoch,level) VALUES($1,$2,$3,'recovery')`, [session.id, user.id, user.epoch + 1]);
  const cookie = context.authCookies.sessionToken;
  const signed = await serializeSignedCookie(cookie.name, session.token, config.authSecret, { ...cookie.attributes, maxAge: 600 });
  await event(db, 'control', user.id, 'admin_recovery_started');
  await outbox(db, 'control', seal, 'security_admin_recovery', { email: user.email });
  return { result: { status: 'new_totp_required' }, cookie: signed };
}
