/**
 * Typed turn-broker protocol errors. Each thrown message stays byte-identical
 * to the plain `Error` it replaced — callers and tests match on message text —
 * while the class lets programmatic callers distinguish token expiry, Zero
 * Risk request revocation, turn-state conflicts and wire-protocol violations
 * without string matching.
 */

/** A turn token (owner or activity) is missing, unknown, expired or revoked. */
export class TurnBrokerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnBrokerTokenError";
  }
}

/** A Zero Risk request id is missing, unregistered, expired, revoked or misbound. */
export class TurnBrokerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnBrokerRequestError";
  }
}

/** The turn is in a state that cannot serve the requested transition (terminal, revoked, draining, conflicting). */
export class TurnBrokerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnBrokerStateError";
  }
}

/** A broker message or owner payload violates the wire contract. */
export class TurnBrokerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnBrokerProtocolError";
  }
}
