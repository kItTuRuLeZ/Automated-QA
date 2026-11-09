const Database = require('better-sqlite3');
const db = new Database('data/qa.sqlite', { readonly: true });
const scormEvidence = db.prepare("SELECT id, kind, caption, data_json FROM evidence WHERE run_id = ? AND kind = 'scorm_api_call'").all('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('SCORM evidence count:', scormEvidence.length);
scormEvidence.forEach(ev => {
  console.log(`Evidence: ${ev.caption}`);
  const data = JSON.parse(ev.data_json);
  console.log('   Summary:', data.summary);
  console.log('   Calls count:', data.calls?.length);
  console.log('   Committed CMI:', data.committed);
  console.log('   Looked for other API:', data.lookedForOtherApi);
});
