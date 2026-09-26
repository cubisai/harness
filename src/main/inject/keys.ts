// The env var name a provider's key is passed in, shared by the injectors that
// hand the key to a spawned agent process instead of writing it to a file.

/** The env var a provider's key is passed in. */
export function providerKeyVar(providerId: string): string {
  return `UNSKILLED_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}
