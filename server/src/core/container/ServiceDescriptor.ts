import type { Lifetime } from './Lifetime.ts';
import type { Container } from './Container.ts';

// A token is the typed identity of a service. The phantom type parameter
// (never present at runtime) is what lets container.get(token) return the
// right type with zero casts at call sites.
declare const serviceType: unique symbol;

export interface ServiceToken<T> {
  readonly name: string;
  /** Phantom marker only — carries T through the type system. */
  readonly [serviceType]?: T;
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
  if (name.trim() === '') {
    throw new Error('A service token needs a non-empty name.');
  }
  return Object.freeze({ name });
}

// Factories receive the container so a service can resolve its own
// dependencies — this is how object graphs wire themselves together.
export type ServiceFactory<T> = (container: Container) => T;

/** One registration: what to build, how to build it, how long it lives. */
export interface ServiceDescriptor<T> {
  readonly token: ServiceToken<T>;
  readonly lifetime: Lifetime;
  readonly factory: ServiceFactory<T>;
}
