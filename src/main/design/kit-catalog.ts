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

/** Where the kits are released: cubisai/harness-plugin's `packs-v1`, one zip per kit. */
const RELEASE = "https://github.com/cubisai/harness-plugin/releases/download/packs-v1";

/** The kits the app offers to install. A new kit version therefore needs an app update. */
export const KIT_CATALOG: readonly KitCatalogEntry[] = [
  { id: "shadcn-ui", name: "shadcn/ui", version: "1.0.0", url: `${RELEASE}/shadcn-ui-1.0.0.zip`, sha256: "2b617a1d8c8c4286e93d483de6a819c734c0a9842834e50d79e774d36a5ff4bd" },
  { id: "mui", name: "MUI", version: "1.0.0", url: `${RELEASE}/mui-1.0.0.zip`, sha256: "2f956b6bafd4794c55573f94a6b7369e948c796a776bcb9e219e9c64557147dd" },
  { id: "ant-design", name: "Ant Design", version: "1.0.0", url: `${RELEASE}/ant-design-1.0.0.zip`, sha256: "6d77b2f36a9d4985c510528427780c1d454e0ac7b2a63f2e87d7652e465b0f0d" },
  { id: "chakra-ui", name: "Chakra UI", version: "1.0.0", url: `${RELEASE}/chakra-ui-1.0.0.zip`, sha256: "573f5552830aa088db4e5da587cb4c515f71cbd6eab0876822e60cdcf116e6fd" },
  { id: "mantine", name: "Mantine", version: "1.0.0", url: `${RELEASE}/mantine-1.0.0.zip`, sha256: "7cd4cf244031b0e57c9baf68482eb8c33a11bb73991d74c9fe7934f0e5348d25" },
  { id: "varelyo-ui", name: "varelyo/ui", version: "1.0.0", url: `${RELEASE}/varelyo-ui-1.0.0.zip`, sha256: "c03251d87d07e110dc96fa932732544dec2572253a9d38865a6940ec7b042bae" },
];
