const http = require('http');
const ExcelJS = require('exceljs');

const req = http.get('http://127.0.0.1:4317/api/runs/5ff66966-c39a-4cea-ad1d-d75478ec3b2c/export.xlsx', (res) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', async () => {
    const buffer = Buffer.concat(chunks);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    console.log('=== Excel Report Sheets & Rows ===');
    workbook.eachSheet((worksheet, sheetId) => {
      console.log(`Sheet #${sheetId}: "${worksheet.name}" - Rows: ${worksheet.rowCount}, Columns: ${worksheet.columnCount}`);
      const headers = [];
      worksheet.getRow(1).eachCell((cell) => headers.push(cell.value));
      console.log(`   Headers (Row 1): ${headers.slice(0, 6).join(' | ')}`);
    });
  });
});

req.on('error', console.error);
