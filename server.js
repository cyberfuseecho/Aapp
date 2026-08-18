const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

const MODEL_DIR = path.join(__dirname, 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'silueta.onnx');
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx';
const PORT = process.env.PORT || 3000;

let ort = null;
let session = null;
let modelLoading = false;
let modelLoadError = null;
let modelReady = false;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const timeout = setTimeout(() => {
      file.destroy();
      reject(new Error('Download timeout'));
    }, 120000);

    const request = https.get(url, { timeout: 30000 }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        if (response.headers.location) {
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
          file.close();
          clearTimeout(timeout);
          return;
        }
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        clearTimeout(timeout);
        file.close(() => resolve());
      });
    });

    request.on('error', (err) => {
      clearTimeout(timeout);
      fs.unlink(dest, () => {});
      reject(err);
    });

    file.on('error', (err) => {
      clearTimeout(timeout);
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function downloadModel() {
  ensureDir(MODEL_DIR);
  if (fs.existsSync(MODEL_PATH)) {
    const stats = fs.statSync(MODEL_PATH);
    if (stats.size > 40000000) {
      console.log('Model already exists (' + Math.round(stats.size / 1024 / 1024) + 'MB)');
      return;
    }
  }
  console.log('Downloading Silueta model (~43MB)...');
  await downloadFile(MODEL_URL, MODEL_PATH);
  console.log('Model downloaded.');
}

async function loadModel() {
  if (session || modelLoading) return;
  modelLoading = true;
  try {
    await downloadModel();
    console.log('Loading ONNX Runtime...');
    ort = require('onnxruntime-node');
    console.log('Loading Silueta model...');
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 1
    });
    modelReady = true;
    console.log('Model ready. Input:', session.inputNames, 'Output:', session.outputNames);
  } catch (err) {
    modelLoadError = err;
    console.error('Model load failed:', err.message);
  } finally {
    modelLoading = false;
  }
}

async function removeBackground(base64Image) {
  if (!modelReady) await loadModel();
  if (!session) throw new Error('Model not available: ' + (modelLoadError?.message || 'unknown'));

  const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  
  const { data, info } = await sharp(buffer)
    .resize(320, 320, { fit: 'fill' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const floatData = new Float32Array(width * height * 3);
  
  for (let i = 0; i < width * height; i++) {
    floatData[i] = data[i * channels] / 255.0;
    floatData[i + width * height] = data[i * channels + 1] / 255.0;
    floatData[i + width * height * 2] = data[i * channels + 2] / 255.0;
  }

  const tensor = new ort.Tensor('float32', floatData, [1, 3, height, width]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;

  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  const maskData = output.data;

  const original = await sharp(buffer).resize(320, 320, { fit: 'fill' }).raw().ensureAlpha().toBuffer();
  const outBuffer = Buffer.alloc(320 * 320 * 4);

  for (let i = 0; i < 320 * 320; i++) {
    const val = Math.max(0, Math.min(1, maskData[i]));
    const alpha = val > 0.5 ? 255 : 0;
    outBuffer[i * 4] = original[i * 4];
    outBuffer[i * 4 + 1] = original[i * 4 + 1];
    outBuffer[i * 4 + 2] = original[i * 4 + 2];
    outBuffer[i * 4 + 3] = alpha;
  }

  const pngBuffer = await sharp(outBuffer, {
    raw: { width: 320, height: 320, channels: 4 }
  }).png().toBuffer();

  return pngBuffer.toString('base64');
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  console.log(`Client ${clientId} connected`);

  ws.send(JSON.stringify({ 
    type: 'status', 
    message: modelReady ? 'Ready' : 'Model loading, please wait...' 
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (data.type === 'remove-bg') {
        console.log(`Processing image from ${clientId}...`);
        const startTime = Date.now();
        
        ws.send(JSON.stringify({ type: 'status', message: 'Processing...' }));
        
        const resultBase64 = await removeBackground(data.image);
        
        ws.send(JSON.stringify({
          type: 'result',
          image: `data:image/png;base64,${resultBase64}`,
          processingTime: Date.now() - startTime
        }));
        
        console.log(`Done for ${clientId} in ${Date.now() - startTime}ms`);
      }
    } catch (err) {
      console.error('Processing error:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log(`Client ${clientId} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  loadModel().catch(console.error);
});
