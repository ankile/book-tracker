import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCf5oh1h3ySg7M31dSpo1YDwVxQDhGR4Es",
  authDomain: "book-tracker-d8f24.firebaseapp.com",
  databaseURL: "https://book-tracker-d8f24.firebaseio.com",
  projectId: "book-tracker-d8f24",
  storageBucket: "book-tracker-d8f24.appspot.com",
  messagingSenderId: "440931185227",
  appId: "1:440931185227:web:950c6941a7471876e8d3ce",
  measurementId: "G-R4HGQYGQJH",
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Initialize services
export const auth = getAuth(app);
export const db = getFirestore(app);
