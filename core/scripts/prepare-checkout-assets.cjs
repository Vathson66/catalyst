const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHECKOUT_JS_DIR = path.join(REPO_ROOT, 'checkout-js');
const CHECKOUT_JS_DIST_DIR = path.join(CHECKOUT_JS_DIR, 'dist');
const CORE_PUBLIC_DIR = path.join(REPO_ROOT, 'core', 'public');
const TARGET_DIR = path.join(CORE_PUBLIC_DIR, 'checkout-js');

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function getAutoLoaderFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((name) => /^auto-loader(?:-[0-9.]+)?\.js$/.test(name))
    .sort();
}

function ensureCheckoutJsBuild() {
  if (!fs.existsSync(CHECKOUT_JS_DIR)) {
    throw new Error(`checkout-js directory not found at ${CHECKOUT_JS_DIR}`);
  }

  const hasAutoLoader = getAutoLoaderFiles(CHECKOUT_JS_DIST_DIR).length > 0;
  const forceBuild = process.env.CHECKOUT_JS_FORCE_BUILD === 'true';

  if (hasAutoLoader && !forceBuild) {
    console.log('[checkout-assets] Reusing existing checkout-js dist output.');
    return;
  }

  const shouldInstall = !fs.existsSync(path.join(CHECKOUT_JS_DIR, 'node_modules'));

  if (shouldInstall) {
    console.log('[checkout-assets] Installing checkout-js dependencies.');
    runCommand('npm', ['ci', '--ignore-scripts'], CHECKOUT_JS_DIR);
  }

  console.log('[checkout-assets] Building checkout-js dist output.');
  runCommand('npm', ['run', 'build'], CHECKOUT_JS_DIR);

  if (getAutoLoaderFiles(CHECKOUT_JS_DIST_DIR).length === 0) {
    throw new Error(
      `checkout-js build completed without auto-loader output in ${CHECKOUT_JS_DIST_DIR}`,
    );
  }
}

function syncCheckoutAssets() {
  fs.mkdirSync(CORE_PUBLIC_DIR, { recursive: true });
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.cpSync(CHECKOUT_JS_DIST_DIR, TARGET_DIR, { recursive: true });

  const autoLoaderFiles = getAutoLoaderFiles(TARGET_DIR);

  if (autoLoaderFiles.length === 0) {
    throw new Error(`No auto-loader files found in ${TARGET_DIR}`);
  }

  const preferredFile =
    autoLoaderFiles.find((name) => /^auto-loader-[0-9.]+\.js$/.test(name)) ?? autoLoaderFiles[0];

  console.log(`[checkout-assets] Synced checkout-js assets to ${TARGET_DIR}`);
  console.log(
    `[checkout-assets] BigCommerce Custom Checkout script URL path: /checkout-js/${preferredFile}`,
  );
}

function main() {
  if (process.env.SKIP_CHECKOUT_JS_ASSETS === 'true') {
    console.log('[checkout-assets] Skipping checkout-js asset preparation by request.');
    return;
  }

  ensureCheckoutJsBuild();
  syncCheckoutAssets();
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`[checkout-assets] ${message}`);
  process.exit(1);
}
