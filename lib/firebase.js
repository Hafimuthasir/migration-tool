const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const config = require("../config.json");

const serviceAccount = require(config.serviceAccountKeyPath);

const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: `${serviceAccount.project_id}.appspot.com`,
});

const db = getFirestore(app);
const bucket = getStorage(app).bucket();

module.exports = { db, bucket };
