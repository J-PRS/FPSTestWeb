const fs = require('fs');
const b = fs.readFileSync('C:/TEMP/_WEB/FPSWebTest/_tools/e2e/shots/map_quicksand.png');
const b64 = b.toString('base64');
const html = '<div style="text-align:center"><img src="data:image/png;base64,' + b64 + '" style="max-width:100%;height:auto;border-radius:var(--radius)" alt="Quicksand bowl mapshot" /></div>';
fs.writeFileSync('C:/Users/JPrice/AppData/Local/Temp/opencode/mapshot_html.txt', html);
console.log('html length:', html.length);