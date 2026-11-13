// Fixture adapter for tests/main-loop.test.mjs: records how many jobs run at the same time.
// It asks for several jobs at once only when the test sets FIXTURE_CONCURRENCY.

import fs from 'node:fs';

let inFlight = 0;
const log = (line) => fs.appendFileSync(process.env.FIXTURE_LOG, `${line}\n`);

export const maxConcurrentJobs = process.env.FIXTURE_CONCURRENCY ? () => Number(process.env.FIXTURE_CONCURRENCY) : undefined;

export async function process_msg(_serviceUrl, message) {
  const payload = message.json();
  inFlight += 1;
  log(`start ${payload.n} jobId=${message.jobId} inFlight=${inFlight}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  inFlight -= 1;
  log(`end ${payload.n}`);
}
