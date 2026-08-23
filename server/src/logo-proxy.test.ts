import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrivateAddress } from "./logo-proxy";

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
