import { EventEmitter } from "node:events";
import type { ActivityEvent, EventKind } from "./types.js";

export class ActivityStore {
  readonly emitter = new EventEmitter();
  private sequence = 0;
  private readonly events: ActivityEvent[] = [];

  publish(
    kind: EventKind,
    title: string,
    status: ActivityEvent["status"] = "info",
    detail?: string,
    data?: unknown,
  ): ActivityEvent {
    const event: ActivityEvent = {
      id: ++this.sequence,
      at: new Date().toISOString(),
      kind,
      title,
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(data === undefined ? {} : { data }),
    };
    this.events.push(event);
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.emitter.emit("event", event);
    return event;
  }

  list(after = 0, limit = 250): ActivityEvent[] {
    return this.events.filter((event) => event.id > after).slice(-limit);
  }

  snapshot(): ActivityEvent[] {
    return this.events.slice(-250);
  }
}
