#!/usr/bin/env node
// Operator tool for the roihu adapter:
//
//   npm run roihu -- check <config.json>   token, FirecREST, Allas and the installation on Roihu
//   npm run roihu -- setup <config.json>   installs the environment and models on Roihu (a Slurm job)
//
// <config.json> is the file you give the consumer as CONFIG_JSON_PATH (MD-roihu-slurm/services/...).
// Keys and token come from the environment, e.g.:  node --env-file=.env src/hpc/cli.mjs check ...
//   FIRECREST_TOKEN or FIRECREST_TOKEN_FILE, ALLAS_ACCESS_KEY, ALLAS_SECRET_KEY

import fs from 'node:fs';
import path from 'node:path';

import { normalizeSettings, renderTemplate, envBlock, sbatchBlock } from '../adapters/roihu.mjs';
import { createFirecrest, tokenFromEnv, tokenExpiry } from './firecrest.mjs';
import { createS3 } from './s3.mjs';

const [command, configPath] = process.argv.slice(2);
if (!['check', 'setup'].includes(command) || !configPath) {
  console.log('usage: node src/hpc/cli.mjs check|setup <config.json>');
  process.exit(2);
}

const configFile = path.resolve(process.cwd(), configPath);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const settings = normalizeSettings(config.provider || {});
const firecrest = createFirecrest({ url: settings.firecrestUrl, system: settings.system, account: settings.account, token: tokenFromEnv() });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok    ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

async function check() {
  console.log(`${config.service?.id}: ${settings.system}/${settings.partition}, account ${settings.account}, bucket ${settings.bucket}\n`);

  await step('FirecREST token', () => {
    const token = tokenFromEnv()();
    const exp = tokenExpiry(token);
    return exp ? `valid for ${((exp * 1000 - Date.now()) / 3600000).toFixed(1)} more hours` : 'no expiry in the token';
  });
  await step('FirecREST API', async () => {
    const info = await firecrest.userinfo();
    return `user ${info?.user?.name || JSON.stringify(info?.user || info).slice(0, 80)}`;
  });
  await step('Roihu installation', async () => {
    const names = await firecrest.list(settings.remoteRoot);
    if (names === null) throw new Error(`${settings.remoteRoot} does not exist: run "setup"`);
    const missing = ['models'].filter((name) => !names.includes(name));
    if (missing.length || !names.some((name) => name.startsWith('venv'))) throw new Error(`${settings.remoteRoot} has ${names.join(', ') || 'nothing'}: run "setup"`);
    return names.join(', ');
  });
  await step('Allas', async () => {
    const s3 = createS3({ accessKey: process.env.ALLAS_ACCESS_KEY, secretKey: process.env.ALLAS_SECRET_KEY, bucket: settings.bucket, endpoint: settings.endpoint });
    await s3.ensureBucket();
    const key = `${config.service?.id || 'md-roihu'}/check-${Date.now()}.txt`;
    await s3.putText(key, 'md-roihu check');
    const back = await s3.getText(key);
    await s3.deletePrefix(key);
    if (back !== 'md-roihu check') throw new Error('an object written to Allas did not read back');
    return `bucket ${settings.bucket}, write, read and delete work`;
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\neverything needed is in place');
}

async function setup() {
  const relative = config.provider?.pipeline?.setup_script;
  if (!relative) throw new Error('the config has no pipeline.setup_script');
  const template = fs.readFileSync(path.resolve(path.dirname(configFile), relative), 'utf8');
  const limit = { ...settings, startupSeconds: 40 * 60, secondsPerPage: 0 };
  const script = renderTemplate(template, {
    SBATCH: sbatchBlock(limit, 0, 'md-roihu-setup'),
    ENV: envBlock(settings.pipelineEnv),
    ROOT: settings.remoteRoot,
  });
  const workdir = `${settings.remoteRoot}/jobs/setup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  await firecrest.mkdir(workdir);
  const jobId = await firecrest.submit({ script, workingDirectory: workdir });
  console.log(`submitted setup job ${jobId} to ${settings.system}/${settings.partition}; log: ${workdir}/slurm-${jobId}.out`);

  let last = '';
  for (;;) {
    await sleep(10000);
    const info = await firecrest.jobInfo(jobId);
    if (info.state !== last) {
      console.log(`${new Date().toLocaleTimeString()} ${info.state}`);
      last = info.state;
    }
    if (info.terminal) {
      const log = await firecrest.view(`${workdir}/slurm-${jobId}.out`);
      console.log('\n--- job log ---\n' + (log || '(no log)'));
      if (info.state !== 'COMPLETED' || !String(log).includes('setup done')) {
        console.log(`setup did not finish (${info.state})`);
        process.exit(1);
      }
      return;
    }
  }
}

try {
  if (command === 'check') {
    await check();
    process.exit(failures ? 1 : 0);
  }
  await setup();
} catch (error) {
  console.log(`error: ${error.message}`);
  process.exit(1);
}
