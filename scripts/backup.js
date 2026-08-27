const { runBackup } = require('../backupCore');

runBackup().then(result => {
  console.log(JSON.stringify(result, null, 2));
}).catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
