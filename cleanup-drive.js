const { google } = require('googleapis');
const fs = require('fs');

const keyFile = process.argv[2];
if (!keyFile) {
  console.error('Usage: node cleanup-drive.js /path/to/key.json');
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function deleteAll() {
  const drive = google.drive({ version: 'v3', auth });
  let deleted = 0;

  // List ALL files including trashed
  let pageToken = null;
  do {
    const res = await drive.files.list({
      pageSize: 100,
      fields: 'nextPageToken, files(id, name, trashed)',
      q: 'trashed=true or trashed=false',
      pageToken: pageToken || undefined,
    });
    const files = res.data.files || [];
    console.log(`Found ${files.length} files (including trashed)`);
    for (const file of files) {
      try {
        console.log(`Deleting: ${file.name} (trashed: ${file.trashed})`);
        await drive.files.delete({ fileId: file.id });
        deleted++;
      } catch (e) {
        console.log(`  Skipped (no permission): ${file.name}`);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Empty trash
  try {
    console.log('Emptying trash...');
    await drive.files.emptyTrash();
    console.log('Trash emptied.');
  } catch (e) {
    console.log('Could not empty trash:', e.message);
  }

  console.log(`Done. Deleted ${deleted} files.`);
}

deleteAll().catch(console.error);
