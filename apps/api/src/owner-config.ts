import { OwnerBootstrapError } from './owner-bootstrap.ts';
import { email } from './types.ts';
export type OwnerSettings = { environment: 'staging'; databaseUrl: string; ownerEmail: string; allowedEmails: string[];
  authorizedKeyPath: string; wrappingKeyPath: string };
/** No environment/connection-string override may route a privileged operator into Production. */
export function ownerSettings(value: Record<string, unknown>): OwnerSettings {
  try {
    const keys = ['environment', 'databaseUrl', 'ownerEmail', 'allowedEmails', 'authorizedKeyPath', 'wrappingKeyPath'];
    if (Object.keys(value).some(k => !keys.includes(k)) || value.environment !== 'staging' || typeof value.databaseUrl !== 'string') throw new Error();
    const url = new URL(value.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.port !== '5411' || url.pathname !== '/finance_staging' || url.username !== 'staging_bootstrap_owner' ||
      !url.password || url.search || url.hash) throw new Error();
    if (!Array.isArray(value.allowedEmails) || value.allowedEmails.length < 1 || value.allowedEmails.length > 5) throw new Error();
    const allowedEmails = value.allowedEmails.map(email), ownerEmail = email(value.ownerEmail);
    if (new Set(allowedEmails).size !== allowedEmails.length || !allowedEmails.includes(ownerEmail) ||
      value.authorizedKeyPath !== '/etc/cashneuro/kms/staging/control/authorized-key.json' ||
      value.wrappingKeyPath !== '/etc/cashneuro/kms/staging/control/wrapping-key.json') throw new Error();
    return { environment: 'staging', databaseUrl: value.databaseUrl, ownerEmail, allowedEmails,
      authorizedKeyPath: value.authorizedKeyPath, wrappingKeyPath: value.wrappingKeyPath };
  } catch { throw new OwnerBootstrapError('OWNER_CONFIGURATION_DENIED'); }
}
