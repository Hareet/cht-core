const { column, Column, ColumnType, Schema, Table } = require('@powersync/web');
console.log('column:', typeof column, column ? Object.keys(column) : 'null');
console.log('ColumnType:', ColumnType);
console.log('Column:', typeof Column);

// Test creating a table
try {
  const t = new Table({ name: 'test', columns: [column.text('name')] });
  console.log('Table with column.text:', t);
} catch(e) {
  console.log('column.text failed:', e.message);
}

try {
  const t = new Table({ name: 'test', columns: [new Column({ name: 'name', type: ColumnType.TEXT })] });
  console.log('Table with new Column:', t);
} catch(e) {
  console.log('new Column failed:', e.message);
}
