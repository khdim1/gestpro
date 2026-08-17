const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

const size = 512;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');

// Dégradé bleu
const grad = ctx.createLinearGradient(0, 0, size, size);
grad.addColorStop(0, '#2c6e9e');
grad.addColorStop(1, '#1a4d6e');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, size, size);

// Texte blanc
ctx.fillStyle = '#ffffff';
ctx.font = `bold ${size * 0.1}px "Segoe UI", "Inter", system-ui`;
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('GestPro', size / 2, size / 2);

const buffer = canvas.toBuffer('image/png');
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), buffer);
console.log('✅ Icône générée : icons/icon-512.png');