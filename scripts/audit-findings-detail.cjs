const http = require('http');

function fetchFindings(runId) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:4317/api/runs/${runId}/findings`, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function run() {
  const findings = await fetchFindings('5ff66966-c39a-4cea-ad1d-d75478ec3b2c');
  console.log('=== Cyber Resilience Act (Run 5ff66966) Findings Audit ===');
  console.log(`Total Findings: ${findings.length}`);
  
  const byCategory = {};
  findings.forEach(f => {
    const cat = f.category || (f.ruleId && f.ruleId.split('-')[0]) || 'other';
    byCategory[cat] = (byCategory[cat] || []).concat(f);
  });

  for (const [cat, list] of Object.entries(byCategory)) {
    console.log(`\nCategory: [${cat.toUpperCase()}] (${list.length} issues)`);
    list.forEach((f, idx) => {
      console.log(`  ${idx + 1}. [${f.severity?.toUpperCase() || 'INFO'}] Rule: ${f.ruleId || f.id}`);
      console.log(`     Title: ${f.title || f.message}`);
      if (f.elementSnippet) console.log(`     Snippet: ${f.elementSnippet.slice(0, 100)}`);
      if (f.remediation) console.log(`     Remediation: ${f.remediation.slice(0, 100)}`);
    });
  }
}

run().catch(console.error);
