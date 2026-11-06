/**
 * Global Vitest setup.
 *
 * HOME points at a fresh temporary folder, so nothing under test (m9k_config writes, logs, daemon
 * files) can touch the user's real ~/.melchizedek. src/config.ts and src/constants.ts read
 * os.homedir() when first imported, which happens after this file runs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'm9k-test-home-'));
