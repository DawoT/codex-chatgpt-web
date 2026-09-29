const MAX_SURFACES = 5;
const MAX_ORDINARY_SURFACES = 4;
const MAX_RESERVED_SURFACES = 1;

class SurfaceAdmission {
  constructor(occupants) {
    this.occupants = occupants;
    this.queue = [];
    this.reservations = new Set();
  }

  get queuedCount() {
    return this.queue.length;
  }

  acquire(kind, signal) {
    if (kind !== "ordinary" && kind !== "reserved") {
      return Promise.reject(new Error(`Unknown browser surface kind: ${kind}`));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const request = { kind, signal, resolve, reject, onAbort: null };
      request.onAbort = () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener("abort", request.onAbort);
        reject(signal.reason);
        this.pump();
      };
      signal?.addEventListener("abort", request.onAbort, { once: true });
      this.queue.push(request);
      this.pump();
    });
  }

  tryAcquire(kind) {
    if (kind !== "ordinary" && kind !== "reserved") {
      throw new Error(`Unknown browser surface kind: ${kind}`);
    }
    if (this.queue.length > 0) return null;
    const occupants = this.occupants();
    const occupied = occupants.length + this.reservations.size;
    const ordinary = occupants.filter(value => value !== "reserved").length
      + [...this.reservations].filter(value => value.kind === "ordinary").length;
    const reserved = occupied - ordinary;
    if (occupied >= MAX_SURFACES
      || (kind === "ordinary" && ordinary >= MAX_ORDINARY_SURFACES)
      || (kind === "reserved" && reserved >= MAX_RESERVED_SURFACES)) {
      return null;
    }
    return this.grant(kind);
  }

  surfaceReleased() {
    this.pump();
  }

  grant(kind) {
    const reservation = { kind };
    this.reservations.add(reservation);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.reservations.delete(reservation);
      this.pump();
    };
    return { commit: settle, release: settle };
  }

  pump() {
    const occupants = this.occupants();
    let occupied = occupants.length + this.reservations.size;
    let ordinary = occupants.filter(kind => kind !== "reserved").length
      + [...this.reservations].filter(reservation => reservation.kind === "ordinary").length;
    let reserved = occupied - ordinary;

    while (occupied < MAX_SURFACES) {
      const index = this.queue.findIndex(request => (
        request.kind === "reserved"
          ? reserved < MAX_RESERVED_SURFACES
          : ordinary < MAX_ORDINARY_SURFACES
      ));
      if (index < 0) return;
      const [request] = this.queue.splice(index, 1);
      request.signal?.removeEventListener("abort", request.onAbort);
      const ticket = this.grant(request.kind);
      occupied += 1;
      if (request.kind === "ordinary") ordinary += 1;
      else reserved += 1;
      request.resolve(ticket);
    }
  }
}

module.exports = {
  MAX_ORDINARY_SURFACES,
  MAX_SURFACES,
  SurfaceAdmission,
};
