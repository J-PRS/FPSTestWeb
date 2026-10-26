const s = await Bun.file('build/dev-win-x64/hello-world-dev/Resources/app/bun/index.js').text();
console.log(s.slice(-1500));
console.log('HAS_UDP:', s.includes('8787'), 'HAS_KRIBES:', s.includes('Kribes'), 'HAS_5400:', s.includes('5400'));
