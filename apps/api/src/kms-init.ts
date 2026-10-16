import { initializeKmsKey, kmsRealms } from './kms.ts';
import type { KmsRealm } from './kms.ts';
const [realm, authPath, outputPath] = process.argv.slice(2);
if (!realm || !Object.hasOwn(kmsRealms, realm) || !authPath || !outputPath || process.argv.length !== 5) throw new Error('Use kms:init realm absolute-auth-path absolute-output-path');
try {
  await initializeKmsKey(realm as KmsRealm, authPath, outputPath);
  console.log('KMS: защищённый ключ приложения создан и проверен.');
} catch { console.error('KMS_INIT_FAILED: файл не перезаписывается; проверьте пути, права и доступ к KMS.'); process.exitCode = 1; }
