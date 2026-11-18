// electron-builder configuration (used by `npm run dist`).
// Build the backend first: `python backend/build_backend.py`.

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'local.playtopia.proxy',
  productName: 'Playtopia Proxy',
  directories: { output: 'dist' },
  files: ['main.js', 'preload.js', 'renderer/**/*', 'package.json'],
  extraResources: [
    { from: '../backend/dist/playtopia-backend.exe', to: 'backend/playtopia-backend.exe' },
    { from: '../shared/rules_schema.json', to: 'shared/rules_schema.json' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName} Setup ${version}.${ext}',
  },
};
