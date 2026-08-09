/** Validate the local ASP registration payload before opening the browser flow. */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const path = resolve('config/asp-registration.yaml');
const raw = readFileSync(path, 'utf8');
const root = parseYaml(raw) as {
  agent?: { name?: unknown; picturePath?: unknown };
  service?: { name?: unknown; title?: unknown; billingModel?: unknown; monthlyPriceUsdt?: unknown; freeTrialHours?: unknown; description?: unknown };
};
const agentName = root.agent?.name;
const picturePath = root.agent?.picturePath;
const service = root.service;
const failures: string[] = [];

if (typeof agentName !== 'string' || agentName.length < 3 || agentName.length > 25) failures.push('agent name must be 3..25 characters');
if (typeof service?.name !== 'string' || service.name.length < 5 || service.name.length > 30) failures.push('service name must be 5..30 characters');
if (agentName === service?.name) failures.push('agent and service names must differ');
const classification = [service?.name, service?.title, service?.description].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
if (!classification.includes('perpetual') && !classification.includes('perp') && !classification.includes('contract')) failures.push('service metadata must classify as perp');
if (service?.billingModel !== 'subscription') failures.push('billing model must be subscription');
if (service?.monthlyPriceUsdt !== '15') failures.push('monthly price must be exactly the listed 15 USDT/month');
if (service?.freeTrialHours !== '72') failures.push('free trial must be exactly 72 hours when present');
if (typeof picturePath !== 'string') {
  failures.push('avatar path is required');
} else {
  const avatar = resolve(picturePath);
  try {
    const stat = statSync(avatar);
    const bytes = readFileSync(avatar);
    if (stat.size > 1_048_576) failures.push(`avatar is ${stat.size} bytes, over the 1 MiB limit`);
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!png) failures.push('avatar must be a PNG upload');
    if (png && (bytes.readUInt32BE(16) !== bytes.readUInt32BE(20))) failures.push('avatar must be square');
  } catch {
    failures.push(`avatar file does not exist at ${avatar}`);
  }
}

if (failures.length > 0) {
  console.error(`REGISTRATION INVALID (${path}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`registration payload valid: ${agentName} / ${service?.name} / ${service?.monthlyPriceUsdt} USDT/month`);
}
