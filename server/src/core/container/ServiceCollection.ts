import { Container } from './Container.ts';
import { Lifetime } from './Lifetime.ts';
import type {
  ServiceDescriptor,
  ServiceFactory,
  ServiceToken,
} from './ServiceDescriptor.ts';

// The registration phase. Collect descriptors here, then build() an
// immutable Container. Splitting registration from resolution (the .NET
// ServiceCollection/ServiceProvider pattern) means wiring can only happen
// at startup — nothing can re-register a service mid-request.
export class ServiceCollection {
  private readonly descriptors = new Map<string, ServiceDescriptor<unknown>>();

  registerSingleton<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): this {
    return this.register(token, Lifetime.Singleton, factory);
  }

  registerTransient<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): this {
    return this.register(token, Lifetime.Transient, factory);
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.descriptors.has(token.name);
  }

  /**
   * Snapshot the registrations into an immutable Container. Registrations
   * added after build() do not leak into already-built containers, and
   * each container gets its own singleton cache.
   */
  build(): Container {
    return new Container(new Map(this.descriptors));
  }

  private register<T>(
    token: ServiceToken<T>,
    lifetime: Lifetime,
    factory: ServiceFactory<T>,
  ): this {
    // Silent replacement is how "which implementation am I actually
    // getting?" bugs are born — duplicates fail loudly instead.
    if (this.descriptors.has(token.name)) {
      throw new Error(
        `Service "${token.name}" is already registered. ` +
          'Each token can only be registered once.',
      );
    }

    this.descriptors.set(token.name, {
      token,
      lifetime,
      factory,
    } as ServiceDescriptor<unknown>);

    return this;
  }
}
