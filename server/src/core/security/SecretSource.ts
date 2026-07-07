// Where secret VALUES come from. Deliberately returns a raw string, not a
// Secret: sources are the boundary where a value first enters the
// framework (including plugin-contributed sources, which mirror this
// shape structurally without importing the Secret class — see
// PluginCapability.ts's module comment on self-contained contribution
// shapes). SecurityService.getSecret() is the one place a raw value gets
// wrapped into a Secret before anything else touches it.
export interface SecretSource {
  readonly name: string;
  getSecret(name: string): string | undefined;
}
