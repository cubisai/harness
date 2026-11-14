/** One installable kit version. The hash ships inside the app, which is what authenticates the download. */
export interface KitCatalogEntry {
  id: string;
  name: string;
  version: string;
  url: string;
  sha256: string;
}

/** Hosts a kit download may be served from, redirects included. */
export const KIT_HOSTS: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
];

/** Filled when the kits are released. A new kit version therefore needs an app update. */
export const KIT_CATALOG: readonly KitCatalogEntry[] = [];
