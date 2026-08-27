'use strict';
// electron-builder's portable target unpacks the exe into a temp folder and
// deletes that folder once the app exits. app.relaunch() with no options
// restarts the UNPACKED copy — which the stub is deleting from under it, so
// the app closes and never comes back. The stub hands the path of the real
// portable exe to the app as PORTABLE_EXECUTABLE_FILE: relaunch that.
function relaunchOptions(env = process.env) {
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  return portable ? { execPath: portable } : undefined;
}

module.exports = { relaunchOptions };
