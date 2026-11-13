// The credentials a user brings for one run, and how they travel.
//
// The UI collects them in a form, packs them into ONE string (MessyDesk's vault keeps one string per
// run: the same mechanism as the API key of an LLM provider) and sends it in the X-MD-API-Key header.
// The consumer trades the task's `secret_ref` for that string and unpacks it here. The string is
// `mdcred1.` + base64url(JSON of the entered values). It is never written to a file or a log.
//
//   token            FirecREST token (https://my.csc.fi/firecrest-token, valid 24 hours)
//   project          CSC project whose Roihu billing units are used (Slurm account), project_NNN
//   allas_project    optional, the Allas project when it is not the same project
//
// The Allas keys are not asked: they are read from the user's own rclone.conf on Roihu (allas-conf).

import { tokenExpiry } from './firecrest.mjs';

export const CREDENTIALS_PREFIX = 'mdcred1.';
const PROJECT = /^project_\d+$/;
// a token must live long enough to be of use
const MIN_TOKEN_SECONDS = 10 * 60;

/** Something that a retry cannot fix: the run is reported as failed at once, with this message. */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** The credentials do not work, and asking the same again would not help: the user has to fix them. */
export class CredentialsError extends PermanentError {
  constructor(message) {
    super(message);
    this.name = 'CredentialsError';
  }
}

export function encodeCredentials(values) {
  const clean = {};
  for (const [name, value] of Object.entries(values || {})) {
    const text = String(value ?? '').trim();
    if (text) clean[name] = text;
  }
  return CREDENTIALS_PREFIX + Buffer.from(JSON.stringify(clean), 'utf8').toString('base64url');
}

/**
 * The checked credentials of a vault string: { token, project, allasProject }.
 * Throws a CredentialsError that says what to fix.
 */
export function decodeCredentials(raw, now = Date.now()) {
  const text = String(raw || '');
  if (!text.startsWith(CREDENTIALS_PREFIX)) {
    throw new CredentialsError('The credentials of this run are not in the expected form. Start the run again from the MessyDesk page.');
  }
  let values;
  try {
    values = JSON.parse(Buffer.from(text.slice(CREDENTIALS_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new CredentialsError('The credentials of this run could not be read. Start the run again.');
  }

  const token = String(values.token || '').trim();
  if (!token) throw new CredentialsError('The FirecREST token is missing. Create one at https://my.csc.fi/firecrest-token and start the run again.');
  const exp = tokenExpiry(token);
  if (exp !== null && exp * 1000 - now < MIN_TOKEN_SECONDS * 1000) {
    throw new CredentialsError('The FirecREST token has expired or expires within minutes. Create a new one at https://my.csc.fi/firecrest-token and start the run again.');
  }

  const project = String(values.project || '').trim();
  if (!PROJECT.test(project)) throw new CredentialsError(`"${project || ''}" is not a CSC project number: it looks like project_2018805.`);
  const allasProject = String(values.allas_project || '').trim() || project;
  if (!PROJECT.test(allasProject)) throw new CredentialsError(`"${allasProject}" is not an Allas project number: it looks like project_2018805.`);

  return { token, project, allasProject };
}
