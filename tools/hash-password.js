'use strict';
/* Generate ADMIN_PASSWORD_HASH for the Glam admin.
 * Usage:  node tools/hash-password.js "your chosen password"
 * Copy the printed  salt:hash  string into the ADMIN_PASSWORD_HASH env var. */
const crypto = require('node:crypto');
const pw = process.argv.slice(2).join(' ').trim();
if (!pw) { console.error('Usage: node tools/hash-password.js "your password"'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
console.log(salt + ':' + hash);
