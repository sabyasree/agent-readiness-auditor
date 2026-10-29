// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
// Copies the audit engine and scan helpers from the extension into the package.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'engine');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, 'content', 'auditor.js'), path.join(out, 'auditor.js'));
fs.copyFileSync(path.join(root, 'lib', 'scan-core.js'), path.join(out, 'scan-core.js'));
console.log('Copied the audit engine into cli/engine/.');
