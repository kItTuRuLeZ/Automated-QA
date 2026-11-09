const Database = require('better-sqlite3');
const db = new Database('data/qa.sqlite', { readonly: true });
const scormEvents = db.prepare("SELECT seq, type, at, payload_json FROM run_events WHERE run_id = ? AND (type LIKE '%scorm%' OR payload_json LIKE '%cmi%' OR payload_json LIKE '%LMS%') ORDER BY seq ASC").all('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('SCORM matching events count:', scormEvents.length);
scormEvents.slice(0, 15).forEach(e => {
  console.log(`[#${e.seq}] [${e.at}] Type: ${e.type} | Payload: ${e.payload_json.slice(0, 140)}`);
});
if (scormEvents.length > 15) {
  console.log('... latest 5:');
  scormEvents.slice(-5).forEach(e => {
    console.log(`[#${e.seq}] [${e.at}] Type: ${e.type} | Payload: ${e.payload_json.slice(0, 140)}`);
  });
}

