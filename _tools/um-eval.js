// Usage: node _tools/um-eval.js <targetId> <expression>
const [targetId, ...rest] = process.argv.slice(2);
const expression = rest.join(' ');
const r = await fetch('http://127.0.0.1:7878/eval', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targetId, expression }),
});
const j = await r.json();
console.log(j?.result?.result?.value ?? JSON.stringify(j));
