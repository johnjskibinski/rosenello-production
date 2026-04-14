const fs = require('fs')
const csv = process.argv[2]
if (!csv) { console.log('Usage: node sniff-csv.js <path-to-csv>'); process.exit(1) }
const lines = fs.readFileSync(csv, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
console.log('HEADERS:', lines[0])
console.log('\nALL ROWS:')
lines.slice(1).forEach((l, i) => console.log(`Row ${i+1}: ${l}`))
