const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "linux") return;

  const appOutDir = context.appOutDir;
  const binName = context.packager.executableName;
  const originalBin = path.join(appOutDir, binName);
  const renamedBin = path.join(appOutDir, binName + ".bin");

  // Rename the real Electron binary
  fs.renameSync(originalBin, renamedBin);

  // Replace it with a wrapper that clears Steam's env vars before launch
  const wrapper = `#!/bin/bash
# Clear Steam environment variables that conflict with Electron's bundled Chromium libs.
# Without this, Steam's LD_PRELOAD and LD_LIBRARY_PATH cause the app to show a black screen.
unset LD_PRELOAD
LD_LIBRARY_PATH=""
exec "$(dirname "$(readlink -f "$0")")/${binName}.bin" "$@"
`;

  fs.writeFileSync(originalBin, wrapper);
  fs.chmodSync(originalBin, 0o755);
};
