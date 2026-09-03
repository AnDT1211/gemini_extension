import * as esbuild from 'esbuild';
import * as fs from 'fs';

const isWatch = process.argv.includes('--watch');

async function build() {
  // Ensure dist directory exists
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }

  // Copy static dist manifest and popup files
  fs.copyFileSync('src/manifest.json', 'dist/manifest.json');
  fs.copyFileSync('src/popup/popup.html', 'dist/popup.html');
  fs.copyFileSync('src/popup/popup.css', 'dist/popup.css');

  // Build TS bundles
  const context = await esbuild.context({
    entryPoints: [
      { in: 'src/background/index.ts', out: 'background' },
      { in: 'src/content/index.ts', out: 'content' },
      { in: 'src/popup/popup.ts', out: 'popup' }
    ],
    bundle: true,
    outdir: 'dist',
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    logLevel: 'info'
  });

  if (isWatch) {
    await context.watch();
    console.log('Watching for changes...');
  } else {
    await context.rebuild();
    await context.dispose();
    console.log('Build completed successfully.');
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
