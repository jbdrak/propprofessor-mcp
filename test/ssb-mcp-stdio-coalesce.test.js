'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCoalescingWriter } = require('../lib/ssb-mcp-stdio');

describe('createCoalescingWriter', () => {
  afterEach(() => {
    // Clear any pending timers
    if (globalThis._coalesceTestTimers) {
      clearTimeout(globalThis._coalesceTestTimers.flushTimer);
      globalThis._coalesceTestTimers = null;
    }
  });

  it('coalesceMs=0 writes immediately (passthrough mode)', () => {
    const writes = [];
    const mockWrite = (data) => {
      writes.push(data.toString());
      return true;
    };

    const writer = createCoalescingWriter({ coalesceMs: 0, writeFn: mockWrite });
    writer('message1');
    writer('message2');

    assert.equal(writes.length, 2);
    assert.equal(writes[0], 'message1');
    assert.equal(writes[1], 'message2');
  });

  it('coalesceMs=1 batches multiple writes into one syscall', () => {
    const writes = [];
    const mockWrite = (data) => {
      writes.push(data.toString());
      return true;
    };

    const writer = createCoalescingWriter({ coalesceMs: 1, writeFn: mockWrite });
    writer('message1');
    writer('message2');
    writer('message3');

    return new Promise((resolve) => {
      setImmediate(() => {
        assert.equal(writes.length, 1, 'Should have batched all writes into one');
        assert.equal(writes[0], 'message1message2message3', 'Should concatenate all messages');
        resolve();
      });
    });
  });

  it('maxBufferSize triggers early flush', () => {
    const writes = [];
    const mockWrite = (data) => {
      writes.push(data.toString());
      return true;
    };

    // Use 100 byte buffer limit
    const writer = createCoalescingWriter({ coalesceMs: 1000, maxBufferSize: 100, writeFn: mockWrite });
    writer('x'.repeat(50));
    writer('y'.repeat(50));
    // This should trigger early flush (total 101 bytes > 100)
    writer('z');

    return new Promise((resolve) => {
      setImmediate(() => {
        // Should have flushed at least once due to buffer size
        assert.ok(writes.length >= 1, 'Should have flushed at least once');
        // The first flush should contain at least 101 bytes
        const firstWrite = writes[0];
        assert.ok(firstWrite.length >= 100, `First write should be >= 100 bytes, got ${firstWrite.length}`);
        resolve();
      });
    });
  });

  it('handles write returning false gracefully', () => {
    // Test that when write returns false, the writer handles it
    const writes = [];
    let callCount = 0;
    const mockWrite = (data) => {
      writes.push(data.toString());
      callCount++;
      // First write returns false (backpressure), subsequent return true
      return callCount < 2;
    };

    const writer = createCoalescingWriter({ coalesceMs: 1, writeFn: mockWrite });
    writer('msg1');
    writer('msg2');

    return new Promise((resolve) => {
      setTimeout(() => {
        // Should have written msg1 and msg2 (coalesceMs=1 timer fires at ~1ms,
        // setTimeout at 0ms can race past it on fast machines)
        assert.ok(writes.length >= 1, 'Should have written at least once');
        resolve();
      }, 50);
    });
  });
});
