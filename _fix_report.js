const fs = require('fs');
let html = fs.readFileSync('report.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.log('No script tag found'); process.exit(1); }
const scriptStart = html.indexOf(scriptMatch[1]);
let script = scriptMatch[1];

let fixed = '';
let inString = false;
let stringChar = '';
let escaped = false;
let fixes = 0;

for (let i = 0; i < script.length; i++) {
  const ch = script[i];

  if (escaped) {
    fixed += ch;
    escaped = false;
    continue;
  }

  if (ch === '\\' && inString) {
    fixed += ch;
    escaped = true;
    continue;
  }

  if (!inString) {
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
    }
    fixed += ch;
    continue;
  }

  if (ch === stringChar) {
    inString = false;
    fixed += ch;
    continue;
  }

  if (ch === '\n' && stringChar !== '`') {
    fixed += '\\n';
    fixes++;
    continue;
  }

  fixed += ch;
}

if (fixes > 0) {
  html = html.substring(0, scriptStart) + fixed + html.substring(scriptStart + script.length);
  fs.writeFileSync('report.html', html);
  console.log('Fixed ' + fixes + ' literal newline(s) inside strings');
} else {
  console.log('No literal newlines in strings found');
}

const newMatch = html.match(/<script>([\s\S]*?)<\/script>/);
try {
  new Function(newMatch[1]);
  console.log('Script syntax: OK');
} catch(e) {
  console.log('Script syntax error remains:', e.message);
}
