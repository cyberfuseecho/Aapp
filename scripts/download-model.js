const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx';
const MODEL_PATH = path.join(__dirname, '..', 'models', 'silueta.onnx');

if (fs.existsSync(MODEL_PATH)) {
  console.log('Model already exists.');
  process.exit(0);
}

console.log('Downloading Silueta model (~43MB)...');

const file = fs.createWriteStream(MODEL_PATH);
https.get(MODEL_URL, (response) => {
  if (response.statusCode === 302 || response.statusCode === 301) {
    https.get(response.headers.location, (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('Model downloaded successfully.');
      });
    });
  } else {
    response.pipe(file);
    file.on('finish', () => {
      file.close();
      console.log('Model downloaded successfully.');
    });
  }
}).on('error', (err) => {
  fs.unlink(MODEL_PATH, () => {});
  console.error('Download failed:', err.message);
  process.exit(1);
});
