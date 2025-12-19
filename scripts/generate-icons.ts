import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const svgPath = path.join(__dirname, '../public/limbo.svg');
const publicDir = path.join(__dirname, '../public');

async function generateIcons() {
  console.log('Generating icons from limbo.svg...');

  // Read SVG
  const svgBuffer = fs.readFileSync(svgPath);

  // Generate PNG icons at various sizes
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(publicDir, `icon-${size}.png`));
    console.log(`  Generated icon-${size}.png`);
  }

  // Generate main icon.png (256x256 for Linux)
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(path.join(publicDir, 'icon.png'));
  console.log('  Generated icon.png (256x256)');

  // For Windows ICO, we need to use a different approach
  // electron-builder can use a 256x256 PNG and convert it
  console.log('\nFor Windows (.ico) and Mac (.icns):');
  console.log('  Option 1: Use https://icoconvert.com to convert icon.png to icon.ico');
  console.log('  Option 2: Use https://cloudconvert.com to convert icon.png to icon.icns');
  console.log('  Option 3: electron-builder will auto-convert from icon.png if formats are missing\n');

  console.log('Icon generation complete!');
}

generateIcons().catch(console.error);
