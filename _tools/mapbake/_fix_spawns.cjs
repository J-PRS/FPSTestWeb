const fs = require('fs');
const spec = JSON.parse(fs.readFileSync('maps/quicksand.json','utf8'));
const spawns = [
  [90, 10], [10, 90], [-90, 10], [-10, 90],
  [-90, -10], [-10, -90], [90, -10], [10, -90],
  [60, 60], [-60, 60], [-60, -60], [60, -60],
];
spec.spawns = spawns.map(([x,z]) => ({ x, y: 0, z, r: 16 }));
fs.writeFileSync('maps/quicksand.json', JSON.stringify(spec, null, 2));
console.log('spawns updated:', spec.spawns.length);