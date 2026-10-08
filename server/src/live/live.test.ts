import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { encoderArgs, ProgressReader, pusherArgs } from "./ffmpeg";
import { cookieFrom, issueToken, passwordMatches, sameOrigin, tokenValid } from "./session";
import {
  LiveInputError,
  LiveStore,
  looksLikeMp3,
  MAX_TRACK_BYTES,
  parseIngestUrl,
  publicDestination,
  redact,
  targetOf,
  trackName,
} from "./store";
import type { IncomingMessage } from "node:http";

describe("the livestream session", () => {
  const password = "correct horse battery staple";

  it("takes the password and nothing else", () => {
    assert.equal(passwordMatches(password, password), true);
    assert.equal(passwordMatches(password, "correct horse battery stapl"), false);
    assert.equal(passwordMatches(password, ""), false);
    assert.equal(passwordMatches(password, undefined), false);
    // An unset password opens nothing, not everything.
    assert.equal(passwordMatches("", ""), false);
  });

  it("accepts its own token until it expires", () => {
    const now = 1_700_000_000_000;
    const token = issueToken(password, now);
    assert.equal(tokenValid(password, token, now + 1), true);
    assert.equal(tokenValid(password, token, now + 8 * 24 * 60 * 60_000), false);
  });

  it("refuses a token signed under another password, or tampered with", () => {
    const now = Date.now();
    const token = issueToken(password, now);
    assert.equal(tokenValid("another password entirely", token, now), false);
    // Pushing the expiry out invalidates the signature over it.
    const [exp, mac] = token.split(".");
    assert.equal(tokenValid(password, `${Number(exp) + 1}.${mac}`, now), false);
    for (const junk of ["", ".", "abc", `${exp}.`, `x.${mac}`]) {
      assert.equal(tokenValid(password, junk, now), false, junk);
    }
  });

  it("reads one cookie out of a header holding several", () => {
    assert.equal(cookieFrom("a=1; crown_live=abc.def; b=2", "crown_live"), "abc.def");
    assert.equal(cookieFrom("crown_livex=1", "crown_live"), undefined);
    assert.equal(cookieFrom(undefined, "crown_live"), undefined);
    assert.equal(cookieFrom("crown_live=%E0%A4%A", "crown_live"), undefined);
  });

  it("tells this origin from another", () => {
    const req = (origin: string | undefined, host: string) =>
      ({ headers: { origin, host } }) as unknown as IncomingMessage;
    assert.equal(sameOrigin(req("https://thecrowngame.fun", "thecrowngame.fun")), true);
    assert.equal(sameOrigin(req("https://evil.example", "thecrowngame.fun")), false);
    assert.equal(sameOrigin(req("null", "thecrowngame.fun")), false);
    assert.equal(sameOrigin(req(undefined, "thecrowngame.fun")), true);
  });
});

describe("a destination", () => {
  it("takes rtmp and rtmps and refuses anything else", () => {
    assert.equal(parseIngestUrl(" rtmp://a.rtmp.youtube.com/live2 "), "rtmp://a.rtmp.youtube.com/live2");
    assert.equal(parseIngestUrl("rtmps://live-api-s.facebook.com:443/rtmp/"), "rtmps://live-api-s.facebook.com:443/rtmp/");
    for (const bad of ["", "https://youtube.com", "file:///etc/passwd", "rtmp://", "rtmp://host/a b", 42]) {
      assert.throws(() => parseIngestUrl(bad), LiveInputError, String(bad));
    }
  });

  it("in production, will not point ffmpeg into the server's own network", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "169.254.169.254", "localhost", "postgres.railway.internal", "box.local"]) {
      assert.throws(() => parseIngestUrl(`rtmp://${host}/live`, { allowInternal: false }), LiveInputError, host);
    }
    assert.equal(parseIngestUrl("rtmp://a.rtmp.youtube.com/live2", { allowInternal: false }), "rtmp://a.rtmp.youtube.com/live2");
    // A developer testing against a local ingest is not production.
    assert.equal(parseIngestUrl("rtmp://127.0.0.1:1935/live", { allowInternal: true }), "rtmp://127.0.0.1:1935/live");
  });

  it("joins the server and the key the way platforms expect", () => {
    assert.equal(targetOf({ url: "rtmp://a.rtmp.youtube.com/live2", key: "abcd-1234" }), "rtmp://a.rtmp.youtube.com/live2/abcd-1234");
    assert.equal(targetOf({ url: "rtmp://host/app/", key: "k" }), "rtmp://host/app/k");
    assert.equal(targetOf({ url: "rtmp://host/app/k", key: "" }), "rtmp://host/app/k");
  });

  it("never hands its key to the browser", () => {
    const d = { id: "x", label: "YouTube", url: "rtmp://h/app", key: "sk_live_0123456789abcdef", enabled: true };
    const shown = JSON.stringify(publicDestination(d));
    assert.equal(shown.includes(d.key), false);
    assert.match(publicDestination(d).keyHint, /cdef$/);
    // A short key would be mostly given away by its last four.
    assert.equal(publicDestination({ ...d, key: "short" }).keyHint, "••••");
  });

  it("is redacted out of ffmpeg's error lines", () => {
    const d = { url: "rtmp://h/app", key: "sk_live_0123456789" };
    const line = `[rtmp @ 0x1] rtmp://h/app/sk_live_0123456789: Input/output error`;
    assert.equal(redact(line, [d]).includes(d.key), false);
  });
});

describe("an uploaded track", () => {
  it("is an MP3 by its first bytes", () => {
    assert.equal(looksLikeMp3(Buffer.from("ID3\x04\x00", "latin1")), true);
    assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true); // MPEG-1 layer III
    assert.equal(looksLikeMp3(Buffer.from([0xff, 0xf1, 0x50, 0x80])), false); // AAC ADTS: layer 00
    assert.equal(looksLikeMp3(Buffer.from("<svg", "latin1")), false);
    assert.equal(looksLikeMp3(Buffer.alloc(0)), false);
  });

  it("is named after its file, without the path or the extension", () => {
    assert.equal(trackName(encodeURIComponent("Lo-Fi Beats.mp3")), "Lo-Fi Beats");
    assert.equal(trackName("..%2F..%2Fetc%2Fpasswd"), "passwd");
    assert.equal(trackName(undefined), "Untitled");
    assert.equal(trackName("%E0%A4%A"), "%E0%A4%A");
  });
});

describe("the live store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crown-live-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 1)]);

  it("keeps destinations across a restart", async () => {
    const store = new LiveStore(dir);
    const a = await store.addDestination({ url: "rtmp://a.example/live", key: "key-a" });
    await store.addDestination({ label: "  Twitch  ", url: "rtmp://b.example/app", key: "key-b" });
    await store.updateDestination(a.id, { enabled: false, key: "" });

    const reopened = await new LiveStore(dir).destinations();
    assert.deepEqual(
      reopened.map((d) => [d.label, d.key, d.enabled]),
      [
        ["a.example", "key-a", false], // a blank key leaves the stored one alone
        ["Twitch", "key-b", true],
      ]
    );
    await store.removeDestination(a.id);
    assert.equal((await store.destinations()).length, 1);
  });

  it("stores an MP3, serves it back, and refuses what isn't one", async () => {
    const store = new LiveStore(dir);
    const track = await store.addTrack("Theme.mp3", Readable.from([mp3]));
    assert.equal(track.name, "Theme");
    assert.equal(track.bytes, mp3.length);
    const file = await store.trackFile(track.id);
    assert.ok(file);
    assert.deepEqual(await readFile(file), mp3);

    await assert.rejects(store.addTrack("x.mp3", Readable.from([Buffer.from("<html>")])), LiveInputError);
    await assert.rejects(store.addTrack("x.mp3", Readable.from([])), LiveInputError);
    assert.equal(await store.trackFile("../config"), null);
    assert.equal((await store.tracks()).length, 1);
  });

  it("cuts an upload off at the size limit", async () => {
    const store = new LiveStore(dir);
    const chunk = Buffer.alloc(1024 * 1024, 0);
    chunk.set(mp3.subarray(0, 10));
    async function* huge() {
      for (let i = 0; i <= MAX_TRACK_BYTES / chunk.length; i++) yield chunk;
    }
    await assert.rejects(store.addTrack("big.mp3", Readable.from(huge())), LiveInputError);
  });

  it("assembles an upload sent in parts, and refuses one that loses its place", async () => {
    const store = new LiveStore(dir);
    const upload = "0123456789abcdef";
    const [a, b] = [mp3.subarray(0, 1000), mp3.subarray(1000)];
    const first = await store.addTrackPart({ upload, offset: 0, final: false, name: "Parts.mp3" }, Readable.from([a]));
    assert.deepEqual(first, { track: null, received: 1000 });
    // A part sent for the wrong offset would splice the file wrong.
    await assert.rejects(
      store.addTrackPart({ upload, offset: 999, final: true, name: "Parts.mp3" }, Readable.from([b])),
      LiveInputError
    );
    // …and costs the upload, which starts over from nothing.
    await store.addTrackPart({ upload, offset: 0, final: false, name: "Parts.mp3" }, Readable.from([a]));
    const done = await store.addTrackPart({ upload, offset: 1000, final: true, name: "Parts.mp3" }, Readable.from([b]));
    assert.equal(done.track?.name, "Parts");
    assert.deepEqual(await readFile((await store.trackFile(upload))!), mp3);
    await assert.rejects(
      store.addTrackPart({ upload: "../../etc/passwd", offset: 0, final: true }, Readable.from([a])),
      LiveInputError
    );
    await assert.rejects(
      store.addTrackPart({ upload: "fedcba9876543210", offset: 0, final: false }, Readable.from([Buffer.from("<html>")])),
      LiveInputError
    );
    await store.removeTrack(upload);
  });

  it("reorders only by a full permutation", async () => {
    const store = new LiveStore(dir);
    const second = await store.addTrack("Second.mp3", Readable.from([mp3]));
    const ids = (await store.tracks()).map((t) => t.id);
    const reversed = await store.reorderTracks([...ids].reverse());
    assert.equal(reversed[0].id, second.id);
    await assert.rejects(store.reorderTracks([ids[0]]), LiveInputError);
    await assert.rejects(store.reorderTracks([ids[0], ids[0]]), LiveInputError);
    await store.removeTrack(second.id);
    assert.equal(await store.trackFile(second.id), null);
  });
});

describe("ffmpeg", () => {
  it("reads -progress blocks however the pipe splits them", () => {
    const reader = new ProgressReader();
    const text =
      "frame=120\nfps=30.00\nbitrate=3456.7kbits/s\ntotal_size=1234567\nout_time_us=4000000\nspeed=1.01x\nprogress=continue\n" +
      "frame=150\nfps=29.9\nbitrate=N/A\nout_time_ms=5000000\nspeed=N/A\nprogress=end\n";
    const out = [...text.slice(0, 37), text.slice(37)].flatMap((piece) => reader.push(piece));
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { fps: 30, kbps: 3456.7, speed: 1.01, outTimeMs: 4000, totalBytes: 1234567 });
    assert.deepEqual(out[1], { fps: 29.9, kbps: null, speed: null, outTimeMs: 5000, totalBytes: null });
  });

  it("encodes the renderer's raw frames and sound once, to a stream a pusher can join part-way through", () => {
    const args = encoderArgs({
      width: 1280, height: 720, fps: 30, videoKbps: 3500, audioKbps: 160, preset: "veryfast", sampleRate: 44100, channels: 2,
    });
    const after = (flag: string, from = 0) => args[args.indexOf(flag, from) + 1];
    assert.equal(after("-f"), "rawvideo");
    // Raw inputs are not probed: waiting to analyse the sound stalled the encoder.
    assert.equal(args.filter((a) => a === "-analyzeduration").length, 2);
    assert.equal(after("-s"), "1280x720");
    assert.equal(after("-i"), "pipe:0");
    assert.equal(after("-i", args.indexOf("pipe:0")), "pipe:3");
    assert.equal(after("-g"), "60");
    assert.equal(after("-keyint_min"), "60");
    assert.equal(args[args.lastIndexOf("-f") + 1], "mpegts");
    assert.equal(args.at(-1), "pipe:1");
  });

  it("copies to the destination as the last argument, untouched", () => {
    const target = "rtmp://h/app/k?x=1&y=2";
    const args = pusherArgs(target);
    assert.equal(args.at(-1), target);
    assert.equal(args[args.indexOf("-c") + 1], "copy");
  });
});
