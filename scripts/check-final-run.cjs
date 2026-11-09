const Database = require('better-sqlite3');
const db = new Database('data/qa.sqlite', { readonly: true });
const checks = db.prepare("SELECT count(*) as total, sum(case when outcome='passed' then 1 else 0 end) as passed, sum(case when outcome='failed' then 1 else 0 end) as failed, sum(case when outcome='needs_review' then 1 else 0 end) as needs_review FROM check_results WHERE run_id = ?").get('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('Checks summary:', checks);
const findings = db.prepare('SELECT id, rule_id, severity, title FROM findings WHERE run_id = ?').all('3ed4960d-432c-48e2-a135-cb2eec6baaf1');
console.log('Findings count:', findings.length);
findings.forEach(f => {
  console.log(`[${f.severity.toUpperCase()}] ${f.rule_id}: ${f.title}`);
});
