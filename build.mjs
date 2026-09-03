import * as esbuild from 'esbuild';
import * as fs from 'fs';

const isWatch = process.argv.includes('--watch');
const buildExtensionOnly = process.argv.includes('--extension-only');
const buildBridgeOnly = process.argv.includes('--bridge-only');

async function buildExtension() {
  const extensionDir = 'dist/extension';
  if (!fs.existsSync(extensionDir)) {
    fs.mkdirSync(extensionDir, { recursive: true });
  }

  // Copy static extension assets
  fs.copyFileSync('src/manifest.json', `${extensionDir}/manifest.json`);
  fs.copyFileSync('src/popup/popup.html', `${extensionDir}/popup.html`);
  fs.copyFileSync('src/popup/popup.css', `${extensionDir}/popup.css`);

  await esbuild.build({
    entryPoints: [
      { in: 'src/background/index.ts', out: 'background' },
      { in: 'src/content/index.ts', out: 'content' },
      { in: 'src/popup/popup.ts', out: 'popup' }
    ],
    bundle: true,
    outdir: extensionDir,
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    logLevel: 'info'
  });

  console.log('Chrome extension build completed -> dist/extension');
}

async function buildBridge() {
  const bridgeDir = 'dist/bridge';
  if (!fs.existsSync(bridgeDir)) {
    fs.mkdirSync(bridgeDir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: ['bridge-server/index.ts'],
    bundle: true,
    outfile: `${bridgeDir}/index.js`,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['ws'],
    sourcemap: false,
    minify: false,
    logLevel: 'info'
  });

  console.log('Bridge server build completed -> dist/bridge/index.js');
}

async function buildTests() {
  const testsDir = 'dist/tests';
  if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
  }

  if (fs.existsSync('tests/bridge.test.ts')) {
    await esbuild.build({
      entryPoints: ['tests/bridge.test.ts'],
      bundle: true,
      outfile: `${testsDir}/bridge.test.js`,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['ws'],
      sourcemap: false,
      minify: false,
      logLevel: 'info'
    });
    console.log('Tests build completed -> dist/tests/bridge.test.js');
  }
}

async function main() {
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }

  if (buildExtensionOnly) {
    await buildExtension();
  } else if (buildBridgeOnly) {
    await buildBridge();
  } else {
    await buildExtension();
    await buildBridge();
    await buildTests();
  }
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
