// Child-process fixture: exercises compiled SDK code against one shared SQLite file.
const { SqliteProjectionReplayStore } = await import(process.argv[2]);
const store = SqliteProjectionReplayStore.open(process.argv[3], { audience: 'fixture:audience', clockSeconds: () => 110 });
process.send('ready');
process.on('message', async message => {
  try {
    const result = await store.claim({ audience: 'fixture:audience', issuer: 'fixture:issuer', projectionId: '1'.repeat(32), acceptBefore: 160, retainUntil: 165 });
    process.send({ result });
    if (message === 'linger') setInterval(() => {}, 1000);
    else { store.close(); process.disconnect(); }
  } catch (error) { process.send({ error: error.message }); store.close(); process.disconnect(); }
});
