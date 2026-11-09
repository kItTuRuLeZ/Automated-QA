const Database = require('better-sqlite3');
const db = new Database('data/qa.sqlite', { readonly: true });
const pkgs = db.prepare('SELECT id, project_id, name, original_filename, kind, created_at FROM course_packages').all();
console.log(pkgs);
