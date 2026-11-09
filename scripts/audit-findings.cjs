const http = require('http');

http.get('http://127.0.0.1:4317/api/runs/99d5ae56-f91a-4bfd-ae55-3825d6c30da9/findings', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const findings = JSON.parse(data);
      console.log('Total findings count:', findings.length);
      const byRule = {};
      const bySeverity = {};
      const byCategory = {};
      findings.forEach(f => {
        const rule = f.ruleId || (f.rule && f.rule.id) || 'unknown';
        byRule[rule] = (byRule[rule] || 0) + 1;
        bySeverity[f.severity || 'unknown'] = (bySeverity[f.severity || 'unknown'] || 0) + 1;
        const cat = f.category || (f.rule && f.rule.category) || 'unknown';
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      });
      console.log('By Severity:', JSON.stringify(bySeverity, null, 2));
      console.log('By Category:', JSON.stringify(byCategory, null, 2));
      console.log('By Rule:', JSON.stringify(byRule, null, 2));
      console.log('\n--- Findings List ---');
      findings.forEach((f, i) => {
        const rule = f.ruleId || (f.rule && f.rule.id);
        const title = f.title || f.message;
        const sev = f.severity;
        const target = f.selector || f.target || (f.element && f.element.selector) || '';
        console.log(`[${i+1}] [${sev.toUpperCase()}] ${rule}: ${title}`);
        if (target) console.log(`    Selector: ${target}`);
        if (f.explanation) console.log(`    Note: ${f.explanation.slice(0, 100)}...`);
      });
    } catch(e) {
      console.error(e.message, data.slice(0, 200));
    }
  });
});
