/**
 * Ambient declarations for the handful of platform globals this package touches.
 *
 * `@evocut/edl` targets browsers, workers, and Node alike, so it configures neither the
 * `DOM` lib nor `@types/node` — either one would let environment-specific APIs leak into a
 * package that must run in all three. These two globals are in every target we support
 * (Node 17+, all modern browsers), so we declare exactly them and nothing else.
 *
 * This file is not emitted, so it cannot collide with a consumer's own lib configuration.
 */

declare function structuredClone<T>(value: T): T;

declare var crypto: { randomUUID?: () => string } | undefined;
