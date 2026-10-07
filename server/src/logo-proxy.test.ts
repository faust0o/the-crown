import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrivateAddress, sniffImageType, sourcesFor } from "./logo-proxy";

/**
 * The logo proxy fetches a URL the caller chose, from inside our network. The
 * only thing standing between that and an SSRF is this predicate, so it is
 * worth pinning down — including the encodings that exist specifically to get
 * past a check like it.
 */
describe("the logo proxy refuses to reach our own network", () => {
  it("blocks loopback, in every notation", () => {
    for (const ip of ["127.0.0.1", "127.1.1.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it("blocks the RFC1918 ranges and their edges", () => {
    for (const ip of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it("allows the public addresses either side of 172.16/12", () => {
    assert.equal(isPrivateAddress("172.15.255.255"), false);
    assert.equal(isPrivateAddress("172.32.0.1"), false);
  });

  it("blocks link-local — this is where cloud metadata lives", () => {
    assert.equal(isPrivateAddress("169.254.169.254"), true);
    assert.equal(isPrivateAddress("fe80::1"), true);
  });

  it("blocks carrier-grade NAT, unspecified, multicast and unique-local", () => {
    for (const ip of ["100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "fd00::1", "fc00::1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it("blocks a v4 private address smuggled inside a v6 literal", () => {
    // The shape a v6-only check waves through: it isn't loopback *as v6*.
    assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true);
  });

  it("refuses anything that isn't an address at all", () => {
    // `lookup` gives us an address or throws, so this is a belt-and-braces
    // default — but the default has to be "no".
    for (const junk of ["", "localhost", "not-an-ip", "999.999.999.999", "0x7f000001"]) {
      assert.equal(isPrivateAddress(junk), true, junk);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "151.101.1.140", "2606:4700::1111"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

/**
 * A response that does not say what it is.
 *
 * Arweave serves some logos with no `Content-Type`, and a proxy that trusted
 * only the header refused them — PENGU and TRUMP were a PNG and a JPEG that
 * drew as lettered discs on every load.
 */
describe("recognising an image from its bytes", () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

  it("names the formats a logo comes in", () => {
    assert.equal(sniffImageType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest")), "image/png");
    assert.equal(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF")), "image/jpeg");
    assert.equal(sniffImageType(bytes("GIF89a", "rest")), "image/gif");
    assert.equal(sniffImageType(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageType(bytes([0, 0, 0, 0x1c], "ftypavif")), "image/avif");
    assert.equal(sniffImageType(bytes([0, 0, 1, 0], "rest")), "image/x-icon");
  });

  it("knows an SVG under a BOM, a declaration or a comment", () => {
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
    assert.equal(
      sniffImageType(Buffer.from('\uFEFF  <?xml version="1.0"?>\n<!-- logo -->\n<svg width="1">')),
      "image/svg+xml"
    );
  });

  it("names nothing it does not recognise — an error page is not a logo", () => {
    assert.equal(sniffImageType(Buffer.from("This request has been rate-limited.")), null);
    assert.equal(sniffImageType(Buffer.from("<!DOCTYPE html><html><body>nope</body></html>")), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

/**
 * Three of the public IPFS gateways are one operator's, and all three answered
 * this server with 429 — cbBTC's and PUMP's logos among the casualties. A CID
 * names the bytes, so any gateway that returns them returns the same image.
 */
describe("where a logo can be fetched from", () => {
  const hrefs = (u: string) => sourcesFor(new URL(u)).map((s) => s.href);

  it("tries the logo's own URL first, then other gateways for the same CID", () => {
    assert.deepEqual(hrefs("https://ipfs.io/ipfs/QmZ7L8yd5j36oXX"), [
      "https://ipfs.io/ipfs/QmZ7L8yd5j36oXX",
      "https://gateway.pinata.cloud/ipfs/QmZ7L8yd5j36oXX",
      "https://4everland.io/ipfs/QmZ7L8yd5j36oXX",
    ]);
  });

  it("reads the CID out of a subdomain gateway, keeping any path under it", () => {
    assert.deepEqual(hrefs("https://bafkreiekxdv4.ipfs.w3s.link"), [
      "https://bafkreiekxdv4.ipfs.w3s.link/",
      "https://gateway.pinata.cloud/ipfs/bafkreiekxdv4",
      "https://4everland.io/ipfs/bafkreiekxdv4",
    ]);
    assert.equal(hrefs("https://bafybeih.ipfs.nftstorage.link/logo.png")[1], "https://gateway.pinata.cloud/ipfs/bafybeih/logo.png");
  });

  it("does not repeat a gateway that is already the source", () => {
    assert.deepEqual(hrefs("https://gateway.pinata.cloud/ipfs/Qm1"), [
      "https://gateway.pinata.cloud/ipfs/Qm1",
      "https://4everland.io/ipfs/Qm1",
    ]);
  });

  it("leaves everything else alone", () => {
    assert.deepEqual(hrefs("https://arweave.net/BW67hICaKGd2"), ["https://arweave.net/BW67hICaKGd2"]);
  });
});
