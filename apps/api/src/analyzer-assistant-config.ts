import { join } from 'node:path';
import type { Pool } from 'pg';
import { privateJson } from './kms.ts';
import { stagingDatabase } from './runtime-key.ts';
import { assistantRuntimeManifest } from './analyzer-assistant-manifest.ts';
import { createStagingAssistantProvider } from './analyzer-assistant-provider.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';

export async function loadAssistantProvider(environment: string, profile: string, databaseUrl: string, pool: Pool) {
  if (process.env.ASSISTANT_ENABLED === undefined || process.env.ASSISTANT_ENABLED === '0') return undefined;
  if (process.env.ASSISTANT_ENABLED !== '1' || environment !== 'staging' || profile !== 'finance' || !process.env.CREDENTIALS_DIRECTORY ||
      process.env.AI_ENABLED === '1' || process.env.ASSISTANT_API_KEY || process.env.ASSISTANT_ENDPOINT) throw new AssistantError('ASSISTANT_STAGING_CONFIGURATION_DENIED');
  stagingDatabase(environment,databaseUrl);
  const settings = await privateJson(join(process.env.CREDENTIALS_DIRECTORY,'assistant-cloud.json'));
  const manifest = await assistantRuntimeManifest();
  return createStagingAssistantProvider(pool,settings,fetch,manifest.sourceSha256);
}
