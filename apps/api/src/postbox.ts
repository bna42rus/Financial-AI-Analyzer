import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeliveryFailure } from './mail-worker.ts';
import type { Transport } from './mail-worker.ts';
import type { Message } from './mail-templates.ts';

export type PostboxConfig = { sender: string; username: string; password: string;
  environment: 'staging' };
export const postboxAddress = (value: string) => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value) && value.length <= 254;
const helper = fileURLToPath(new URL('./postbox-smtp.py', import.meta.url));

/** A timeout/failed bridge may occur after SMTP acceptance; never blindly retry. */
export function smtpBridge(payload: Record<string, string>): Promise<{ acceptance?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 15000);
    const finish = (result?: { acceptance?: string; error?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (result) resolve(result); else reject(new DeliveryFailure('DELIVERY_UNKNOWN'));
    };
    child.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 1024) { child.kill('SIGKILL'); finish(); }
    });
    child.on('close', code => {
      if (code !== 0) return finish();
      try { const value = JSON.parse(output) as { acceptance?: string; error?: string }; finish(value); } catch { finish(); }
    });
    child.stdin.on('error', () => finish());
    child.stdin.end(JSON.stringify(payload));
  });
}

export function postboxTransport(config: PostboxConfig, bridge: typeof smtpBridge = smtpBridge): Transport {
  if (config.environment !== 'staging' || config.sender !== 'notifications@cashneuro.ru' ||
    !config.username || config.username.length > 256 || !config.password || config.password.length > 4096) throw new Error('POSTBOX_CONFIGURATION_DENIED');
  return { idempotent: false, async deliver(id: string, message: Message) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
      !postboxAddress(message.to) ||
      typeof message.subject !== 'string' || /[\r\n]/.test(message.subject) || message.subject.length > 500 ||
      typeof message.text !== 'string' || Buffer.byteLength(message.text) > 65536 ||
      (message.html !== undefined && (typeof message.html !== 'string' || Buffer.byteLength(message.html) > 65536))) throw new DeliveryFailure('REJECTED');
    const result = await bridge({ sender: config.sender, username: config.username, password: config.password,
      id, to: message.to, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
    if (result.acceptance === 'postbox' && !result.error) return { acceptance: 'postbox' };
    if (result.error === 'TEMPORARY') throw new DeliveryFailure('TEMPORARY', true);
    if (result.error === 'REJECTED') throw new DeliveryFailure('REJECTED');
    throw new DeliveryFailure('DELIVERY_UNKNOWN');
  } };
}
