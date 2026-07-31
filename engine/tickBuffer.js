// engine/tickBuffer.js

class TickBuffer {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.buffers = {};   // symbol → array of numbers (oldest first)
  }

  setMaxSize(size) {
    this.maxSize = size;
    for (const sym in this.buffers) {
      if (this.buffers[sym].length > this.maxSize) {
        this.buffers[sym] = this.buffers[sym].slice(-this.maxSize);
      }
    }
  }

  push(symbol, price) {
    if (!this.buffers[symbol]) {
      this.buffers[symbol] = [];
    }
    const buf = this.buffers[symbol];
    buf.push(price);
    if (buf.length > this.maxSize) {
      buf.shift();
    }
    return buf.length;
  }

  get(symbol) {
    return this.buffers[symbol] ? [...this.buffers[symbol]] : [];
  }

  symbols() {
    return Object.keys(this.buffers);
  }
}

module.exports = TickBuffer;
