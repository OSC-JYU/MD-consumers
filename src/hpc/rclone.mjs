// rclone.conf as `allas-conf` writes it on Roihu: where the user's own Allas keys are.
//
//   [s3allas-project_2018805]
//   type = s3
//   provider = Other
//   access_key_id = ...
//   secret_access_key = ...
//   endpoint = a3s.fi

import { CredentialsError } from './credentials.mjs';

/** { section: { key: value } } of an INI file. */
export function parseRcloneConf(text) {
  const sections = {};
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = {};
      sections[header[1].trim()] = current;
      continue;
    }
    const pair = /^\s*([^=#;\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2];
  }
  return sections;
}

/**
 * The S3 keys of the Allas project in a rclone.conf. Throws a CredentialsError that tells what to do;
 * the message names sections, never keys.
 */
export function allasKeysFromConf(text, allasProject, path = '~/.config/rclone/rclone.conf') {
  const sections = parseRcloneConf(text);
  const name = `s3allas-${allasProject}`;
  const section = sections[name];
  if (!section || !section.access_key_id || !section.secret_access_key) {
    const known = Object.keys(sections).filter((s) => s.startsWith('s3allas-'));
    throw new CredentialsError(
      `No Allas keys for ${allasProject} in ${path} on Roihu${known.length ? ` (it has ${known.join(', ')})` : ''}. ` +
      `Log in to Roihu and run "module load allas; allas-conf ${allasProject}" once, then start the run again.`,
    );
  }
  return { accessKey: section.access_key_id, secretKey: section.secret_access_key };
}
