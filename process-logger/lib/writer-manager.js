'use strict';
/**
 * WriterManager (singleton)
 * Manages one MeasurementWriter per OPC UA connection.
 *
 * API:
 *  - initFromServer(opts)                  fetch connections from local /api/opcua/connections and create writers
 *  - createForConnection(conn)             create (or re-use) a writer for a connection object
 *  - updateForConnection(conn)             alias for createForConnection (recreates writer on update)
 *  - removeForConnection(connectionId)     close and remove writer for a connection
 *  - getWriter(connectionId)               return existing writer or undefined
 *  - closeAll()                            close all writers
 */

const http = require('http');
const path = require('path');
// Note: measurement-writer exports a factory function: createWriter(connectionId, opts)
const createWriter = require('./measurement-writer');

class WriterManager {
  constructor() {
    this._writers = new Map(); // connectionId -> MeasurementWriter
    this._opts = {};
  }

  _defaultDataDir() {
    return this._opts.dataDir || path.join(process.cwd(), 'data', 'measurements');
  }

  createForConnection(conn) {
    if (!conn || !conn.id) return;
    const id = String(conn.id);
    if (this._writers.has(id)) return this._writers.get(id);

    // Call the factory correctly: createWriter(connectionId, opts)
    const writer = createWriter(id, {
      dataDir: this._defaultDataDir(),
      batchSize: this._opts.batchSize || 200,
      flushIntervalMs: this._opts.flushIntervalMs || 5000
    });

    this._writers.set(id, writer);
    console.log(`writer-manager: created writer for connection ${id}`);
    return writer;
  }

  updateForConnection(conn) {
    if (!conn || !conn.id) return;
    const id = String(conn.id);
    // Close existing writer and create a new one to pick up config changes
    if (this._writers.has(id)) {
      try { this._writers.get(id).close(); } catch (e) {
        console.warn(`writer-manager: error closing writer for connection ${id} during update:`, e && e.message ? e.message : String(e));
      }
      this._writers.delete(id);
    }
    return this.createForConnection(conn);
  }

  removeForConnection(connectionId) {
    const id = String(connectionId);
    if (this._writers.has(id)) {
      try { this._writers.get(id).close(); } catch (e) {
        console.warn(`writer-manager: error closing writer for connection ${id}:`, e && e.message ? e.message : String(e));
      }
      this._writers.delete(id);
      console.log(`writer-manager: removed writer for connection ${id}`);
    }
  }

  getWriter(connectionId) {
    return this._writers.get(String(connectionId));
  }

  async initFromServer(opts) {
    this._opts = opts || {};
    const port = this._opts.serverPort || this._opts.port || process.env.PORT || 3000;

    let connections = [];
    try {
      connections = await this._fetchConnections(port);
    } catch (e) {
      console.warn('writer-manager: could not fetch connections:', e && e.message);
    }
    for (const conn of connections) {
      try { this.createForConnection(conn); } catch (e) {
        console.warn(`writer-manager: error creating writer for connection ${conn.id}:`, e && e.message);
      }
    }
    console.log(`writer-manager: initialized ${this._writers.size} writer(s)`);
  }

  _fetchConnections(port) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port: Number(port),
        path: '/api/opcua/connections',
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '[]');
            resolve(Array.isArray(json) ? json : []);
          } catch (e) {
            resolve([]);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async closeAll() {
    for (const [id, writer] of this._writers.entries()) {
      try { writer.close(); } catch (e) {
        console.warn(`writer-manager: error closing writer for connection ${id}:`, e && e.message);
      }
    }
    this._writers.clear();
    console.log('writer-manager: all writers closed');
  }
}

module.exports = new WriterManager();