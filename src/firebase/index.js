import firebase from "firebase/app"; // rollup bundle issue with ESM import
import "firebase/auth";
import "firebase/firestore";

var firebaseConfig = {
  apiKey: "AIzaSyCf5oh1h3ySg7M31dSpo1YDwVxQDhGR4Es",
  authDomain: "book-tracker-d8f24.firebaseapp.com",
  databaseURL: "https://book-tracker-d8f24.firebaseio.com",
  projectId: "book-tracker-d8f24",
  storageBucket: "book-tracker-d8f24.appspot.com",
  messagingSenderId: "440931185227",
  appId: "1:440931185227:web:950c6941a7471876e8d3ce",
  measurementId: "G-R4HGQYGQJH",
};

firebase.initializeApp(firebaseConfig);

// export const auth = firebase.auth();

export const db = firebase.firestore();
