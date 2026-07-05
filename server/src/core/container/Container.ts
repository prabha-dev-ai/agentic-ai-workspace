import { Lifetime } from './Lifetime.ts';
import type { ServiceDescriptor, ServiceToken } from './ServiceDescriptor.ts';

// The resolution phase. A Container is built from a snapshot of
// registrations and is immutable: nothing can be added or replaced after
// build, so the object graph the app starts with is the one it keeps.
export class Container {
  private readonly descriptors: ReadonlyMap<string, ServiceDescriptor<unknown>>;

  // Lazy singleton cache: instances are created on first get(), never at
  // registration or build time. Services that are never asked for are
  // never constructed.
  private readonly singletons = new Map<string, unknown>();

  // Names currently being constructed — a factory that (transitively)
  // resolves itself is a circular dependency, reported as a readable
  // chain instead of a stack overflow.
  private readonly resolving: string[] = [];

  constructor(descriptors: ReadonlyMap<string, ServiceDescriptor<unknown>>) {
    this.descriptors = descriptors;
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.descriptors.has(token.name);
  }

  /** Resolve a required service. Throws if the token was never registered. */
  get<T>(token: ServiceToken<T>): T {
    const descriptor = this.descriptors.get(token.name);

    if (!descriptor) {
      throw new Error(
        `No service registered for token "${token.name}". ` +
          'Register it on the ServiceCollection before calling build().',
      );
    }

    return this.instantiate(descriptor) as T;
  }

  /** Resolve an optional service. Returns undefined instead of throwing. */
  resolve<T>(token: ServiceToken<T>): T | undefined {
    return this.has(token) ? this.get(token) : undefined;
  }

  private instantiate(descriptor: ServiceDescriptor<unknown>): unknown {
    if (descriptor.lifetime === Lifetime.Singleton) {
      if (!this.singletons.has(descriptor.token.name)) {
        this.singletons.set(descriptor.token.name, this.create(descriptor));
      }
      return this.singletons.get(descriptor.token.name);
    }

    return this.create(descriptor);
  }

  private create(descriptor: ServiceDescriptor<unknown>): unknown {
    const { name } = descriptor.token;

    if (this.resolving.includes(name)) {
      throw new Error(
        `Circular dependency detected: ${[...this.resolving, name].join(' -> ')}`,
      );
    }

    this.resolving.push(name);
    try {
      return descriptor.factory(this);
    } finally {
      this.resolving.pop();
    }
  }
}
