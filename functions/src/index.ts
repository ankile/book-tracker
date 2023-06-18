import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
const axios = require("axios");

// import google cloud pubsub
import { PubSub } from "@google-cloud/pubsub";

admin.initializeApp();

function getNowLocalTimestamp() {
  const now = new Date();

  const offset = now.getTimezoneOffset();
  const hours = Math.floor(offset / 60);
  const minutes = offset % 60;

  const tz =
    (hours >= 0 ? "+" : "") +
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0");

  const formattedDate =
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0") +
    "T" +
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0") +
    tz;

  return formattedDate;
}

exports.bookIsFinished = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}")
  .onUpdate(async (snap, _) => {
    // Grab the current value of what was written to Cloud Firestore.
    const { currentPage, pageCount, finished } = snap.after.data();

    if (currentPage === pageCount) {
      if (!finished) {
        return snap.after.ref.set({ finished: true }, { merge: true });
      }
    } else if (finished) {
      return snap.after.ref.set({ finished: false }, { merge: true });
    }

    return null;
  });

exports.createBookUpdate = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}/updates/{updateId}")
  .onCreate(async (snap, context) => {
    const { bookId, userId } = context.params;
    // Grab the current value of what was written to Cloud Firestore.
    const { type, fromPage, toPage } = snap.data();

    const timeRead = type === "reading" ? snap.data().timeRead : 0;
    const pagesRead = type === "reading" ? toPage - fromPage : 0;

    await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(bookId)
      .update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        currentPage: toPage,
        pagesRead: admin.firestore.FieldValue.increment(pagesRead),
        timeRead: admin.firestore.FieldValue.increment(timeRead),
      });

    // Publish a message to the Cloud Pub/sub habitiy-log topic containing the user id and the time read
    const pubsub = new PubSub();
    const topicName = "habitify-log";
    const dataBuffer = Buffer.from(
      JSON.stringify({
        userId,
        timeRead,
      })
    );

    await pubsub.topic(topicName).publishMessage({ data: dataBuffer });
    return null;
  });

exports.deleteBookUpdate = functions
  .region("europe-west1")
  .firestore.document("/users/{userId}/books/{bookId}/updates/{updateId}")
  .onDelete(async (snap, context) => {
    const { bookId, userId } = context.params;
    // Grab the current value of what was written to Cloud Firestore.
    const { type, fromPage, toPage } = snap.data();

    const timeRead = type === "reading" ? snap.data().timeRead : 0;

    await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("books")
      .doc(bookId)
      .update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        currentPage: fromPage,
        pagesRead: admin.firestore.FieldValue.increment(-(toPage - fromPage)),
        timeRead: admin.firestore.FieldValue.increment(-timeRead),
      });

    return null;
  });

exports.updateHabitify = functions
  .region("europe-west1")
  .pubsub.topic("habitify-log")
  .onPublish(async (message) => {
    const { userId, timeRead } = JSON.parse(
      Buffer.from(message.data, "base64").toString()
    );

    // Check if the user has Habitify connected
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      return null;
    }

    const userData = userDoc.data();

    if (!userData || !userData.habitify) {
      return null;
    }

    const { habitify } = userData;

    // Get the API key and habit id from the user document
    const { apiKey, habitId } = habitify;

    // Create the request body
    const body = {
      unit_type: "min",
      value: timeRead,
      target_date: getNowLocalTimestamp(),
    };

    // Send the request to the Habitify API
    try {
      const url = `https://api.habitify.me/logs/${habitId}`;
      console.log(
        `Sending request to Habitify API with url: ${url}, body: ${JSON.stringify(
          body
        )}, and apiKey: ${apiKey}`
      );
      const response = await axios({
        url: url,
        method: "POST",
        data: body,
        headers: {
          Authorization: apiKey,
        },
      });
      if (response) {
        // Print the response status code
        console.log(
          `Habitify API responded with status code: ${response.status}`
        );
      }
    } catch (error) {
      console.log(error);
    }

    return null;
  });

exports.createUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onCreate(async (user) => {
    await admin.firestore().collection("users").doc(user.uid).set({
      email: user.email,
      uid: user.uid,
    });
    return null;
  });

exports.deleteUserDocument = functions
  .region("europe-west1")
  .auth.user()
  .onDelete(async (user) => {
    await admin.firestore().collection("users").doc(user.uid).delete();
    return null;
  });

exports.booksapi = require("./booksapi");
