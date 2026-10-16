import { describe, expect, it } from "vitest";
import { createLinkPreviews, fetchableUrl, isPublicAddress, ogImage } from "../src/main/link-preview";

describe("link previews", () => {
  it("allows only public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("fetches only https URLs on named public hosts", () => {
    expect(fetchableUrl("https://github.com/penpot/penpot")?.hostname).toBe("github.com");
    for (const raw of ["http://github.com", "file:///etc/passwd", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://router.local/x", "https://intranet/x", "https://user:pw@github.com/", "javascript:alert(1)", "not a url"]) {
      expect(fetchableUrl(raw)).toBeNull();
    }
  });

  it("finds a page's og:image in any attribute order, resolved against the page", () => {
    const base = new URL("https://example.com/a/b");
    expect(ogImage('<meta property="og:image" content="/img/card.png">', base)).toBe("https://example.com/img/card.png");
    expect(ogImage("<meta content='https://cdn.x.com/i.jpg?a=1&amp;b=2' name='twitter:image'>", base)).toBe("https://cdn.x.com/i.jpg?a=1&b=2");
    expect(ogImage('<meta name="description" content="hi">', base)).toBeNull();
  });

  it("never reaches the network for a URL it refuses, and caches the answer", async () => {
    const previews = createLinkPreviews();
    const first = previews.image("http://insecure.example.com/x.png", "image");
    expect(previews.image("http://insecure.example.com/x.png", "image")).toBe(first);
    expect(await first).toBeNull();
    expect(await previews.image("https://192.168.1.1/", "page")).toBeNull();
  });
});
