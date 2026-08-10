import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from './index.js';

const fns = getFunctions(app, 'europe-west1');

export const togglSaveToken = httpsCallable(fns, 'toggl-savetoken');
export const togglStart = httpsCallable(fns, 'toggl-start');
export const togglStop = httpsCallable(fns, 'toggl-stop');
export const adminOverview = httpsCallable(fns, 'admin-overview');
