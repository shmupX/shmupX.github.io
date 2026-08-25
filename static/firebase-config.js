// The one copy of the Evil Invaders Firebase config that game pages use.
//
// Loaded by the hosted player (routes/games/2028-ai.tsx) and staged into every
// exported app by tools/build-level, so a level's leaderboard works the same in
// both. These are public client credentials — the same values the level editor
// already ships inline — and the database is guarded by its own RTDB rules, not
// by hiding this file.
//
// firebaseScores.js reads __FIREBASE_CONFIG__; level-loader.js accepts either
// this or the older `firebaseConfig` spelling, so both are set.
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyAHY_agipyNEXvY2J4jDgnlk9kLeM6O37Y",
  authDomain: "evil-invaders.firebaseapp.com",
  databaseURL: "https://evil-invaders-default-rtdb.firebaseio.com",
  projectId: "evil-invaders",
  storageBucket: "evil-invaders.firebasestorage.app",
  messagingSenderId: "149257705855",
  appId: "1:149257705855:web:3f048481dfc66cef61224a",
};
window.firebaseConfig = window.firebaseConfig || window.__FIREBASE_CONFIG__;
