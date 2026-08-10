import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

// Load service account key
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// Enumerating users and books with .get() is load-bearing: .get() skips
// missing-ancestor documents, so updates orphaned under a deleted book (or
// deleted user doc) are never backfilled. That is deliberate — giving an
// orphan an owner would resurrect a deleted book's sessions into the
// heatmap. Do not switch to listDocuments(), which surfaces those parents.
async function migrateOwnerToReadingSessions() {
  console.log('Starting migration to add owner reference to reading sessions...');

  const usersSnapshot = await db.collection('users').get();
  let totalUpdated = 0;

  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    console.log(`Processing user: ${userId}`);

    const ownerRef = db.doc(`users/${userId}`);
    const booksSnapshot = await db.collection('users').doc(userId).collection('books').get();

    for (const bookDoc of booksSnapshot.docs) {
      const bookId = bookDoc.id;
      const updatesSnapshot = await db.collection('users').doc(userId).collection('books').doc(bookId).collection('updates').get();

      if (updatesSnapshot.empty) continue;

      // Batch updates in groups of 500 (Firestore limit)
      let batch = db.batch();
      let batchCount = 0;

      for (const updateDoc of updatesSnapshot.docs) {
        const data = updateDoc.data();

        // Every doc in the subcollection belongs to the path's user, so
        // owner applies regardless of type ('reading' and 'update' alike).
        if (!data.owner) {
          const updateRef = db.collection('users').doc(userId).collection('books').doc(bookId).collection('updates').doc(updateDoc.id);
          batch.update(updateRef, { owner: ownerRef });
          batchCount++;
          totalUpdated++;

          // Commit batch if we hit 500 operations
          if (batchCount >= 500) {
            await batch.commit();
            console.log(`Committed batch of ${batchCount} updates`);
            batch = db.batch();
            batchCount = 0;
          }
        }
      }

      // Commit remaining updates
      if (batchCount > 0) {
        await batch.commit();
        console.log(`Committed final batch of ${batchCount} updates for book ${bookId}`);
      }
    }
  }

  console.log(`Migration complete! Updated ${totalUpdated} reading sessions.`);
}

migrateOwnerToReadingSessions()
  .then(() => {
    console.log('Migration finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
