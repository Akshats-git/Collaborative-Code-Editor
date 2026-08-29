import type { BusListener, DocumentBus } from '../../src/cluster/index.js';
import { encodeBusMessage, decodeBusMessage, type BusKindValue } from '../../src/cluster/index.js';

/**
 * An in-process stand-in for Redis, shared by several `createApp` calls so a
 * test can run two instances against one bus.
 *
 * It goes through the same encode/decode path as the real thing and drops the
 * publisher's own echo the same way, so what the tests exercise is the room and
 * registry logic rather than a simplified version of it.
 */
export class MemoryDocumentBus {
  private readonly channels = new Map<string, Set<Endpoint>>();

  /** Each call returns a bus that looks like its own instance to the others. */
  endpoint(instanceId: string): DocumentBus {
    return new Endpoint(this.channels, instanceId);
  }
}

class Endpoint implements DocumentBus {
  private readonly subscribed = new Map<string, BusListener>();

  constructor(
    private readonly channels: Map<string, Set<Endpoint>>,
    private readonly instanceId: string,
  ) {}

  async subscribe(documentId: string, listener: BusListener): Promise<void> {
    this.subscribed.set(documentId, listener);
    let members = this.channels.get(documentId);
    if (!members) {
      members = new Set();
      this.channels.set(documentId, members);
    }
    members.add(this);
  }

  async unsubscribe(documentId: string): Promise<void> {
    this.subscribed.delete(documentId);
    this.channels.get(documentId)?.delete(this);
  }

  publish(documentId: string, kind: BusKindValue, payload: Uint8Array): void {
    const frame = encodeBusMessage({ kind, origin: this.instanceId, payload });
    for (const member of this.channels.get(documentId) ?? []) {
      // Redis delivers to the publisher too; the filter lives in the bus there
      // as well, so keep it here rather than in the caller.
      if (member.instanceId === this.instanceId) continue;
      member.deliver(documentId, frame);
    }
  }

  async close(): Promise<void> {
    for (const documentId of [...this.subscribed.keys()]) await this.unsubscribe(documentId);
  }

  private deliver(documentId: string, frame: Uint8Array): void {
    this.subscribed.get(documentId)?.(decodeBusMessage(frame));
  }
}
