'use strict';

// Verification only: intentionally reparent a detached native child so the
// process ledger must use inherited ownership, not just a current parent tree.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
  '-i', 'color=c=blue:s=160x90:r=1', '-f', 'null', '-'], { detached: true, stdio: 'ignore' });
child.once('spawn', () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ wrapper: process.pid, native: child.pid }));
  child.unref();
});
child.once('error', () => { process.exitCode = 1; });
