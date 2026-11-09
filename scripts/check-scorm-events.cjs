const Database = require('better-sqlite3');
const db = new Database('data/qa.sqlite', { readonly: true });
const run = db.prepare('SELECT id, status, queued_at FROM scan_runs WHERE id = ?').get('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('Run:', run);
const events = db.prepare('SELECT seq, type, at, payload_json FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 10').all('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('Latest 10 run events:');
events.forEach(e => {
  console.log(`[#${e.seq}] [${e.at}] Type: ${e.type}`);
  console.log('   Payload:', e.payload_json.slice(0, 160));
});
const units = db.prepare('SELECT count(*) as count, sum(case when visited_at is not null then 1 else 0 end) as visited FROM inventory_units WHERE run_id = ?').get('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('Inventory units:', units);

