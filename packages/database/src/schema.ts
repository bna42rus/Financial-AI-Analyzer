import { pgSchema, text, boolean, timestamp, customType, integer } from 'drizzle-orm/pg-core';

/** The control profile never loads identity or financial repositories. */
export function authSchema(scope: 'identity' | 'control', seal: (v: string) => string, open: (v: string) => string) {
  const schema = pgSchema(scope);
  const protectedText = customType<{ data: string; driverData: string }>({
    dataType: () => 'text', toDriver: seal, fromDriver: open,
  });
  const user = schema.table('auth_user', {
    id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false), image: text('image'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  });
  const session = schema.table('auth_session', {
    id: text('id').primaryKey(), token: text('token').notNull().unique(), userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'), userAgent: text('user_agent'),
  });
  const account = schema.table('auth_account', {
    id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(), userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    password: text('password'), accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'), scope: text('scope'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }), refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  });
  const verification = schema.table('auth_verification', {
    id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  });
  const twoFactor = schema.table('auth_two_factor', {
    id: text('id').primaryKey(), userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
    secret: protectedText('secret').notNull(), backupCodes: protectedText('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(true), failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  });
  return { user, session, account, verification, twoFactor };
}
