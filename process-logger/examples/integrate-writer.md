# Integrating MeasurementWriter into the Poller

## Overview

`lib/measurement-writer.js` provides a `MeasurementWriter` class that writes raw OPC UA samples into per-connection, per-month SQLite files with WAL mode and batched transactions for throughput.

**File layout created by the writer:**
```
<dataDir>/
  <connectionId>/
    measurements-202501.db
    measurements-202502.db
    ...
```

## Installation

`better-sqlite3` is already listed in `package.json`. Run:

```bash
npm install
```

## Usage

### 1. Require and instantiate (once per connection)

```javascript
const createWriter = require('./lib/measurement-writer');

const writer = createWriter('my-connection-id', {
  dataDir: '/opt/process-logger/data/measurements', // optional, defaults to <cwd>/data/measurements
  batchSize: 2000,       // optional, flush after N samples (default 1000)
  flushIntervalMs: 1000  // optional, periodic flush interval ms (default 1000)
});
```

### 2. Push samples from the poller callback

Call `writer.push(sample)` each time a new OPC UA value arrives:

```javascript
subscription.monitor(item, (dataValue) => {
  writer.push({
    logpoint_id: logpoint.id,              // string UUID of the logpoint
    ts: dataValue.sourceTimestamp.getTime(), // Unix ms
    value: dataValue.value.value,           // number or null
    status: dataValue.statusCode.toString(), // e.g. 'Good'
    serverTimestamp: dataValue.serverTimestamp
      ? dataValue.serverTimestamp.getTime()
      : undefined
  });
});
```

### 3. Close the writer on shutdown

```javascript
process.on('SIGTERM', async () => {
  await writer.close(); // flushes remaining buffer and closes all DB handles
  process.exit(0);
});
```

## DB Schema

See [`../sql/schema.sql`](../sql/schema.sql) for the full schema applied to each monthly DB on creation.

| Column          | Type    | Description                        |
|-----------------|---------|------------------------------------|
| logpoint_id     | TEXT    | UUID of the logpoint               |
| ts              | INTEGER | Source timestamp (Unix ms)         |
| value           | REAL    | Measured value (null if not set)   |
| status          | TEXT    | OPC UA status string               |
| serverTimestamp | INTEGER | Server timestamp (Unix ms, optional)|

Primary key is `(logpoint_id, ts)` – duplicate samples with identical key are replaced.
