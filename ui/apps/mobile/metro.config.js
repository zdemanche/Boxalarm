const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// npm workspaces hoist node_modules to the repo root (boxalarm-ui/node_modules) instead of
// apps/mobile/node_modules, so Metro's default single-project resolution can't find
// react-native itself. Watch the workspace root and check its node_modules too.
const workspaceRoot = path.resolve(__dirname, '../..');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
});
