const http = require('http');

const payload = JSON.stringify({
  acknowledgeLocalExecution: true,
  qaProfile: 'full',
  functional: true,
  autoAnswer: true,
  explore: true,
  accessibility: true,
  layout: true,
  maxStates: 60,
  maxDepth: 25,
});

const req = http.request(
  'http://127.0.0.1:4317/api/packages/26c24a2e-ca0e-481e-89ce-5eb075b51f64/scans',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-QA-Request': '1',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let d = '';
    res.on('data', chunk => d += chunk);
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      console.log('Response:', d);
    });
  }
);

req.on('error', console.error);
req.write(payload);
req.end();
