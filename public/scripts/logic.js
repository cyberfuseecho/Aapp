class BGRemover {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnect = 5;
    this.currentImage = null;
    this.initElements();
    this.connect();
    this.bindEvents();
  }

  initElements() {
    this.uploadArea = document.getElementById('uploadArea');
    this.fileInput = document.getElementById('fileInput');
    this.originalImg = document.getElementById('originalImg');
    this.resultImg = document.getElementById('resultImg');
    this.originalPlaceholder = document.getElementById('originalPlaceholder');
    this.resultPlaceholder = document.getElementById('resultPlaceholder');
    this.status = document.getElementById('status');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.connStatus = document.getElementById('connStatus');
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    this.updateConnectionStatus('connecting');
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.showStatus('Ready to remove backgrounds', 'success');
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      this.updateConnectionStatus('disconnected');
      if (this.reconnectAttempts < this.maxReconnect) {
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
      }
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      this.showStatus('Connection error', 'error');
    };
  }

  updateConnectionStatus(state) {
    this.connStatus.className = `connection-status ${state}`;
    this.connStatus.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }

  handleMessage(data) {
    switch (data.type) {
      case 'pong':
        break;
      case 'status':
        this.showStatus(data.message, 'processing');
        break;
      case 'result':
        this.displayResult(data.image, data.processingTime);
        break;
      case 'error':
        this.showStatus(data.message, 'error');
        this.resultPlaceholder.textContent = 'Error';
        break;
    }
  }

  bindEvents() {
    this.uploadArea.addEventListener('click', () => this.fileInput.click());
    
    this.fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) this.processFile(e.target.files[0]);
    });

    this.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadArea.classList.add('dragover');
    });

    this.uploadArea.addEventListener('dragleave', () => {
      this.uploadArea.classList.remove('dragover');
    });

    this.uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadArea.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) this.processFile(file);
    });

    this.downloadBtn.addEventListener('click', () => this.downloadResult());
  }

  async processFile(file) {
    if (!file.type.startsWith('image/')) {
      this.showStatus('Please upload an image file', 'error');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      this.showStatus('Image too large (max 10MB)', 'error');
      return;
    }

    try {
      const base64 = await this.fileToBase64(file);
      this.currentImage = base64;
      
      this.originalImg.src = base64;
      this.originalImg.classList.add('visible');
      this.originalPlaceholder.style.display = 'none';
      
      this.resultImg.classList.remove('visible');
      this.resultPlaceholder.style.display = 'flex';
      this.resultPlaceholder.textContent = 'Processing...';
      this.downloadBtn.classList.remove('visible');
      
      this.showStatus('Uploading...', 'processing');
      
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'remove-bg',
          image: base64
        }));
      } else {
        this.showStatus('Not connected to server', 'error');
      }
    } catch (err) {
      this.showStatus('Failed to read image', 'error');
      console.error(err);
    }
  }

  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  displayResult(imageBase64, processingTime) {
    this.resultImg.src = imageBase64;
    this.resultImg.classList.add('visible');
    this.resultPlaceholder.style.display = 'none';
    this.downloadBtn.classList.add('visible');
    this.showStatus(`Done in ${processingTime}ms`, 'success');
  }

  downloadResult() {
    if (!this.resultImg.src) return;
    const link = document.createElement('a');
    link.href = this.resultImg.src;
    link.download = `bg-removed-${Date.now()}.png`;
    link.click();
  }

  showStatus(message, type) {
    this.status.textContent = message;
    this.status.className = `status active ${type}`;
    if (type === 'success' || type === 'error') {
      setTimeout(() => {
        this.status.classList.remove('active');
      }, 5000);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BGRemover();
});
