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
//
// The database is shared with cmg. shmupX's own games (levels/, levelAliases/)
// and its character library (characters/, atlases/) live under the shmupX/
// subtree of it (lib/rtdb-root.ts); every other node, the leaderboards
// included, stays at the root, and the root-level copies of those four are
// cmg's. So databaseURL stays the root, and the root goes on the PATH: the
// Firebase SDK refuses a databaseURL with a path in it, so SDK readers spell
// __RTDB_ROOT__ into their ref() paths. The characters library module
// (easierbycode.com/2019-es7/characters, and its <character-editor>) reads
// characters/<n> and atlases/<key> over REST from __CHARACTERS_DB__, which is
// therefore the database URL with the root on it.
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
window.__RTDB_ROOT__ = "shmupX";
window.__CHARACTERS_DB__ = window.__FIREBASE_CONFIG__.databaseURL + "/" + window.__RTDB_ROOT__;
