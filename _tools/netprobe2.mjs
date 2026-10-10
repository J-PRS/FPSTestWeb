import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] });
const p = await b.newPage();
p.on('console', m => { const t=m.text(); if(t.match(/Net|net |stall|silent|down|dead|close|disc|tier|reprob/i)) console.log('[pg]',t.slice(0,200)); });
p.on('pageerror', e => console.log('[ERR]', e.message.slice(0,400)));
await p.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, (parseInt(process.argv[3]??'15'))*1000));
await b.close();
console.log('done');
