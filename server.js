const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

const MODEL_PATH = path.join(__dirname, 'models', 'silueta.onnx');
const PORT = process.env.PORT || 3000;

let session = null;
let modelLoading = false;
let modelLoadError = null;

async function loadModel() {
  if (session || modelLoading) return;
  modelLoading = true;
  try {
    console.log('Loading Silueta model...');
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 1
    });
    console.log('Model loaded. Input:', session.inputNames, 'Output:', session.outputNames);
  } catch (err) {
    modelLoadError = err;
    console.error('Model load failed:', err.message);
  } finally {
    modelLoading = false;
  }
}

async function removeBackground(base64Image) {
  if (!session) await loadModel();
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
